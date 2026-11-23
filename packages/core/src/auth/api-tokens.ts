import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { AccessDeniedError } from '../access/access-denied-error.js';
import {
  API_PERSONAL_TOKENS_SETTING,
  API_SENSITIVE_TOKENS_SETTING,
  apiTokenSettingRows,
  readApiTokenSwitches,
  switchesFromRows,
  type ApiTokenSwitches,
} from '../access/api-token-switches.js';
import type { TokenCredential } from '../access/credential.js';
import {
  hasOrganisationPermission,
  organisationPermissionReaches,
} from '../access/organisation-permission.js';
import { permissionAccess } from '../access/permission-access.js';
import { hasProjectPermission } from '../access/project-permission.js';
import { userReachesProject } from '../access/project-reach.js';
import {
  API_TOKEN_ACCESS,
  apiToken,
  orgMembership,
  permission,
  settingValue,
  user,
  type ApiTokenAccess,
  type ApiTokenRevokeReason,
} from '../db/schema/index.js';
import {
  insertRecord,
  lockOrganisationChanges,
  RecordNotFoundError,
  RecordWriteError,
  updateRecord,
  type Tx,
  type WriteContext,
} from '../db/write.js';
import {
  API_MANAGE_PERMISSION,
  API_TOKENS_PERMISSION,
} from './api-token-permissions.js';
import {
  ApiSensitiveTokensDisabledError,
  ApiTokenInvalidError,
  ApiTokensDisabledError,
  NotASensitivePermissionError,
  TokenExceedsOwnAccessError,
  type ApiTokenFailureReason,
} from './api-token-errors.js';
import { AuthInputError } from './errors.js';
import { uncoveredPermissions } from './escalation.js';
import {
  SESSION_DEFAULTS,
  SESSION_USER_COLUMNS,
  type SessionUser,
} from './sessions.js';
import {
  AUTH_AUDIT,
  guardedAuth,
  isOneOf,
  recordAuthAudit,
  serverId,
} from './shared.js';
import { generateToken, hashToken } from './tokens.js';

/**
 * Personal API tokens (SC-10, decisions D-17 and D-68): a secret a person makes for
 * their own scripts and tools, which acts as them, narrowed by what the token says, and
 * never beyond what they hold. The token is `osfpm_pat_` and a session token's 43
 * characters (`generateToken`); the fixed start lets secret scanners, such as GitHub's,
 * recognise a leaked one. Only the SHA-256 hash of its random part is stored (the fixed
 * start is public), found by that hash, and the token goes back to its owner once, in the
 * response that makes it; it is never stored, logged or audited. `api_token` is a security table: only this service writes it,
 * directly, and every change is audited instead of change-logged. The write helper
 * refuses it (`SecurityTableWriteError`).
 *
 * Each organisation has two switches, both off by default, kept as organisation settings
 * (`api.personal-tokens` and `api.personal-tokens.sensitive`, read by
 * `readApiTokenSwitches` in `src/access/`). `setApiTokenSwitches` writes them, and turning
 * one off revokes the tokens it governs in the same transaction. `createApiToken` and
 * `authenticateApiToken` both read them, so a token is refused even if a revocation was
 * missed.
 *
 * Pass the transaction handle and the time as `now`. The services that decide for a
 * signed-in person check their permission themselves, in the organisation: `api:tokens`
 * for the owner's own tokens, `api:manage` for the switches and for any token's metadata
 * and revocation. `authenticateApiToken` takes the token as the capability and checks no
 * permission.
 *
 * Lock order (CLAUDE.md, Data rules). Anything that writes a switch or reads one to decide
 * on a token takes the organisation's change counter first (`lockOrganisationChanges`):
 * `setApiTokenSwitches` and `createApiToken`. So a token being made and a switch being
 * turned off queue on the counter, and either the token is made and then revoked, or the
 * switch is read off and the token refused: never a live token the switches do not
 * allow. A bulk revocation locks the token rows in id order before it changes them, so two
 * of them (a switch turned off, an admin reset link used) cannot deadlock. Revoking one
 * token is one conditional UPDATE: it locks that row and then, for the foreign key of
 * `revoked_by`, takes a key-share lock on the revoker's user row. `createApiToken` and
 * `setApiTokenSwitches` hold the counter and may wait for a user row the same way (the
 * keys of the new token; the setting row), which is the order CLAUDE.md gives: counter,
 * then the user row. No writer that holds a counter waits for an invite row or a reset row.
 *
 * Known limit. `useAccessReset` takes the user row `FOR UPDATE` and then the token rows,
 * the reverse of a single revoke, so a person who revokes their own token at the very
 * moment their own reset link is used can deadlock with it; so can an administrator whose
 * own reset link is used while they turn a switch off. PostgreSQL ends one of the two and
 * a retry goes through. A fix would take the acting user's row `FOR KEY SHARE` before the
 * token rows in `revokeOne` and `setApiTokenSwitches`; CLAUDE.md's lock order does not
 * name token rows yet.
 */

/** What a token starts with, so a leaked one can be recognised by a secret scanner. */
export const API_TOKEN_PREFIX = 'osfpm_pat_';

/**
 * How long a token works, in days: a year unless the owner asks for another number
 * between `minDays` and `maxDays`, or for no end at all (`noExpiry`). Maintainer decision,
 * D-68: expiry is optional, and the default is 365 days. Not a legal or financial number.
 */
export const API_TOKEN_LIFETIME = {
  defaultDays: 365,
  minDays: 1,
  maxDays: 3650,
} as const;

/** The longest name a token takes, in characters. The table's CHECK says the same. */
export const API_TOKEN_NAME_MAX_LENGTH = 100;

/** The most keys one token's sensitive scope may list, so a body is never a reason to do a lot of work. */
export const API_TOKEN_MAX_SENSITIVE_PERMISSIONS = 100;

/** The longest key accepted in a sensitive scope: no permission key is anywhere near it. */
const MAX_PERMISSION_KEY_LENGTH = 100;

/** How many characters of the random part make the prefix that tells tokens apart. */
const PREFIX_RANDOM_CHARACTERS = 8;

/**
 * A token as `createApiToken` makes it: the start, and the 43 characters of 32 random bytes.
 * The one group is the random part, which is what is hashed: the fixed start carries no
 * secret, so the hash is made of exactly what a session token's is (`generateToken`).
 */
const TOKEN_SHAPE = /^osfpm_pat_([A-Za-z0-9_-]{43})$/;

/** What a UUID looks like, so a value that is not one never reaches a `uuid` column. */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The methods a request can have, for the outside-call event. */
const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/** The longest route pattern the outside-call event keeps. */
const MAX_ROUTE_LENGTH = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many times a prefix that is taken is tried again with a new token: it should never happen. */
const PREFIX_ATTEMPTS = 5;

/** The name of the unique key on the prefix, read from a refused insert. */
const PREFIX_UNIQUE_KEY = 'api_token_prefix_unique';

/** The person making, listing or revoking tokens, or turning the switches. */
export type ApiTokenActor = {
  /** The signed-in user. The permission is checked for them, in the organisation. */
  readonly userId: string;
};

/** What `createApiToken` is given. */
export type CreateApiTokenInput = {
  /** A name for the owner and the administrators to tell tokens apart: 1 to 100 characters, trimmed. */
  readonly name: string;
  /** The one project the token works in. `null` or left out, the whole organisation. */
  readonly projectId?: string | null;
  /** `read` calls only routes that read and passes only permissions classed `read`. */
  readonly access: ApiTokenAccess;
  /** `API_TOKEN_LIFETIME.defaultDays` when left out, unless `noExpiry` is set. */
  readonly expiresInDays?: number;
  /** The token never expires. Cannot be combined with `expiresInDays`. */
  readonly noExpiry?: boolean;
  /** The sensitive permissions the token may pass, by key. None when left out. */
  readonly sensitivePermissions?: readonly string[];
};

/** A token as the services show it: never the token or its hash. */
export type ApiTokenView = {
  readonly id: string;
  readonly organisationId: string;
  /** The owner. */
  readonly userId: string;
  readonly projectId: string | null;
  readonly name: string;
  /** `osfpm_pat_` and the first 8 characters of the random part: all of the token that is kept. */
  readonly prefix: string;
  readonly access: ApiTokenAccess;
  readonly sensitivePermissions: readonly string[];
  /** When it ends, or null when it never does. */
  readonly expiresAt: Date | null;
  /** True when `expiresAt` is null, so a list can say so without a reader checking. */
  readonly neverExpires: boolean;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
};

/** What an administrator sees: a token with the name of its owner. */
export type OrganisationApiTokenView = ApiTokenView & {
  /** The owner's display name, as the member list shows it. */
  readonly ownerDisplayName: string;
};

/** The two switches to set. */
export type ApiTokenSwitchesInput = {
  /** Allow personal API tokens in the organisation. */
  readonly personalTokens: boolean;
  /** Allow a token to carry a sensitive scope. Can only be on while `personalTokens` is. */
  readonly sensitive: boolean;
};

/** What `setApiTokenSwitches` answers: the switches as they are now, and how many tokens it revoked. */
export type ApiTokenSwitchesResult = ApiTokenSwitches & {
  readonly revoked: number;
};

/** What `authenticateApiToken` is told about the request the token came with. */
export type AuthenticatingRequest = {
  /**
   * The organisation the request names in its path, when it names one. A token works in
   * its own organisation only, so a token used for another's is refused like any other
   * token that does not work (`wrong-organisation`): one answer, with the cause in the
   * audit trail alone, and nothing said about whether the other organisation exists.
   */
  readonly organisationId?: string;
  /**
   * Whether a refusal is written to the audit trail (`auth.api-token-auth-failed`); it is
   * unless this is `false`. The API says `false` for an address that is already over the
   * strict limit, so a flood of bad tokens writes no more rows than the limit allows. The
   * refusal itself is the same `ApiTokenInvalidError` either way.
   */
  readonly auditFailure?: boolean;
};

/** What `authenticateApiToken` answers for a token that works. */
export type AuthenticatedApiToken = {
  /** What the token may do: pass it to the permission checks. */
  readonly credential: TokenCredential;
  /** The owner, as a session's user is shown. */
  readonly user: SessionUser;
};

/** The columns of an `ApiTokenView`, without the token hash and the revoke fields. */
const viewColumns = {
  id: apiToken.id,
  organisationId: apiToken.organisationId,
  userId: apiToken.userId,
  projectId: apiToken.projectId,
  name: apiToken.name,
  prefix: apiToken.prefix,
  access: apiToken.access,
  sensitivePermissions: apiToken.sensitivePermissions,
  expiresAt: apiToken.expiresAt,
  createdAt: apiToken.createdAt,
  lastUsedAt: apiToken.lastUsedAt,
};

type ViewRow = {
  readonly id: string;
  readonly organisationId: string;
  readonly userId: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly prefix: string;
  readonly access: ApiTokenAccess;
  readonly sensitivePermissions: string[];
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
};

/** The view of a row: the same fields, and whether it never expires. */
function toView(row: ViewRow): ApiTokenView {
  return {
    id: row.id,
    organisationId: row.organisationId,
    userId: row.userId,
    projectId: row.projectId,
    name: row.name,
    prefix: row.prefix,
    access: row.access,
    sensitivePermissions: [...row.sensitivePermissions],
    expiresAt: row.expiresAt,
    neverExpires: row.expiresAt === null,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

/** The tokens that still work at `now`: not revoked, and not past their end if they have one. */
const liveAt = (now: Date): SQL =>
  and(
    isNull(apiToken.revokedAt),
    or(isNull(apiToken.expiresAt), gt(apiToken.expiresAt, now)),
  )!;

/**
 * Refuses unless `userId` holds `key` in `organisationId`. The organisation was named by
 * id, so the refusal carries no scope and is the same for an organisation that does not
 * exist, one the user is not in, and one they are in without the permission: it never says
 * which (CLAUDE.md, Code rules: 404 or 403 where existence must not leak). Not audited:
 * only sensitive data and legal holds audit a denial.
 */
async function requirePermission(
  tx: Tx,
  userId: string,
  organisationId: string,
  key: string,
): Promise<void> {
  if (
    !UUID_SHAPE.test(userId) ||
    !UUID_SHAPE.test(organisationId) ||
    !(await hasOrganisationPermission(tx, userId, organisationId, key))
  ) {
    throw new AccessDeniedError(key);
  }
}

type CheckedCreate = {
  readonly name: string;
  readonly projectId: string | null;
  readonly access: ApiTokenAccess;
  /** Null for a token that never expires. */
  readonly days: number | null;
  /** Each key once, in the order given. */
  readonly sensitivePermissions: readonly string[];
};

/**
 * Checks the shape of what `createApiToken` was given, before anything is looked up, and
 * puts it in the form it is stored in. Each refusal names the field and never the value.
 */
function checkedCreate(input: CreateApiTokenInput): CheckedCreate {
  if (typeof input.name !== 'string') throw new AuthInputError('name');
  const name = input.name.trim();
  // Counted in characters, as the table's CHECK counts them, and with no control
  // character: a name is shown in lists and read in logs.
  const length = [...name].length;
  if (
    length < 1 ||
    length > API_TOKEN_NAME_MAX_LENGTH ||
    /\p{Cc}/u.test(name)
  ) {
    throw new AuthInputError('name');
  }
  if (!isOneOf(API_TOKEN_ACCESS, input.access)) {
    throw new AuthInputError('access');
  }
  const noExpiry = input.noExpiry === undefined ? false : input.noExpiry;
  if (typeof noExpiry !== 'boolean') throw new AuthInputError('noExpiry');
  if (noExpiry && input.expiresInDays !== undefined) {
    throw new AuthInputError('noExpiry');
  }
  let days: number | null = null;
  if (!noExpiry) {
    // `undefined` is "not asked"; `null`, a string or anything else is a value that is
    // not a number, which `??` would have taken for the default.
    days =
      input.expiresInDays === undefined
        ? API_TOKEN_LIFETIME.defaultDays
        : input.expiresInDays;
    if (
      typeof days !== 'number' ||
      !Number.isInteger(days) ||
      days < API_TOKEN_LIFETIME.minDays ||
      days > API_TOKEN_LIFETIME.maxDays
    ) {
      throw new AuthInputError('expiresInDays');
    }
  }
  let projectId: string | null = null;
  if (input.projectId !== undefined && input.projectId !== null) {
    if (
      typeof input.projectId !== 'string' ||
      !UUID_SHAPE.test(input.projectId)
    ) {
      throw new AuthInputError('projectId');
    }
    projectId = input.projectId.toLowerCase();
  }
  const given = input.sensitivePermissions ?? [];
  if (
    !Array.isArray(given) ||
    given.length > API_TOKEN_MAX_SENSITIVE_PERMISSIONS ||
    !given.every(
      (key): key is string =>
        typeof key === 'string' &&
        key.length >= 1 &&
        key.length <= MAX_PERMISSION_KEY_LENGTH,
    )
  ) {
    throw new AuthInputError('sensitivePermissions');
  }
  return {
    name,
    projectId,
    access: input.access,
    days,
    sensitivePermissions: [...new Set(given)],
  };
}

/**
 * Checks a sensitive scope against the catalogue, the token's access and what the owner
 * holds, in that order, and throws at the first that fails (nothing is written). Every key
 * must be a permission flagged `grants_sensitive` (`NotASensitivePermissionError`, naming
 * where in the list); a `read` token may list only `read` permissions, so a key that
 * changes data is a bad request; and the owner must hold each key where the token works:
 * in the organisation for a token of the whole organisation, with the rule against
 * escalation that invites and reset links share, and on the project for a project token
 * (`TokenExceedsOwnAccessError`). A sensitive permission is never held for all projects,
 * so a project token needs a membership of the project that holds it (CLAUDE.md, Privacy
 * rule).
 */
async function checkSensitiveScope(
  tx: Tx,
  userId: string,
  organisationId: string,
  checked: CheckedCreate,
): Promise<void> {
  const keys = checked.sensitivePermissions;
  const found = await tx
    .select({ key: permission.key })
    .from(permission)
    .where(
      and(
        inArray(permission.key, [...keys]),
        eq(permission.grantsSensitive, true),
      ),
    );
  const sensitive = new Set(found.map((row) => row.key));
  const notSensitive = keys.flatMap((key, index) =>
    sensitive.has(key) ? [] : [index],
  );
  if (notSensitive.length > 0)
    throw new NotASensitivePermissionError(notSensitive);

  if (
    checked.access === 'read' &&
    keys.some((key) => permissionAccess(key) === 'write')
  ) {
    throw new AuthInputError('sensitivePermissions');
  }

  let missing: string[];
  if (checked.projectId === null) {
    missing = uncoveredPermissions(
      await organisationPermissionReaches(tx, userId, organisationId),
      keys.map((key) => ({ key, reach: 'own-scope' as const })),
    );
  } else {
    missing = [];
    for (const key of keys) {
      if (!(await hasProjectPermission(tx, userId, checked.projectId, key))) {
        missing.push(key);
      }
    }
    missing.sort();
  }
  if (missing.length > 0) throw new TokenExceedsOwnAccessError(missing);
}

/** True when `error` is the database refusing a second token with the same prefix. */
function isPrefixCollision(error: unknown): boolean {
  return (
    error instanceof RecordWriteError &&
    error.code === '23505' &&
    error.constraint === PREFIX_UNIQUE_KEY
  );
}

/**
 * Inserts the row of a new token under a token made here, and returns the row's view
 * with the token. Two tokens with the same first 8 characters (48 bits) should never
 * happen, but one that does is not the person's fault: the insert is tried again with
 * another token, up to `PREFIX_ATTEMPTS` times, each in a savepoint of its own so a
 * taken prefix does not abort the transaction. Any other refusal is thrown as it is.
 */
async function insertWithFreshToken(
  tx: Tx,
  values: Omit<typeof apiToken.$inferInsert, 'prefix' | 'tokenHash'>,
): Promise<{ row: ViewRow; token: string }> {
  for (let attempt = 1; ; attempt += 1) {
    // The hash is of the random part alone: the fixed start is public and adds nothing.
    const secret = generateToken();
    const token = `${API_TOKEN_PREFIX}${secret}`;
    try {
      return await guardedAuth('api_token', 'insert', () =>
        tx.transaction(async (savepoint) => {
          const [row] = await savepoint
            .insert(apiToken)
            .values({
              ...values,
              prefix: token.slice(
                0,
                API_TOKEN_PREFIX.length + PREFIX_RANDOM_CHARACTERS,
              ),
              tokenHash: hashToken(secret),
            })
            .returning(viewColumns);
          return { row: row!, token };
        }),
      );
    } catch (error) {
      if (attempt < PREFIX_ATTEMPTS && isPrefixCollision(error)) continue;
      throw error;
    }
  }
}

/**
 * Makes a personal API token for the person asking, and returns it with the token, which
 * exists nowhere else: the caller shows it once. Needs `api:tokens` in the organisation,
 * and the organisation's switch for personal tokens on (`ApiTokensDisabledError`). The
 * token lasts `expiresInDays` (1 to 3650, 365 when left out) from `now`, or never when
 * `noExpiry` is set; the two cannot be combined. A `projectId` must be a live project of
 * the organisation that the person can reach (a membership of it, or a grant for every
 * project), or it is a bad request that says nothing about why, as for an invite's role.
 *
 * `sensitivePermissions` is the explicit sensitive scope (decision D-68). It needs the
 * organisation's sensitive switch on (`ApiSensitiveTokensDisabledError`); each key must be
 * a permission flagged `grants_sensitive` (`NotASensitivePermissionError`); a `read` token
 * may list only `read` permissions; and the person must hold each key where the token
 * works (`TokenExceedsOwnAccessError`), because a token never exceeds its owner's access.
 * See `checkSensitiveScope`.
 *
 * The organisation's change counter is taken before the switches are read, after the
 * permission, which reads without a lock (the roles of the person changing a moment later
 * is not what that guards). So this and the turning off of a switch (`setApiTokenSwitches`)
 * queue on it, and a token is never left live that the switches do not allow. Audited as
 * `auth.api-token-created` with the token's id, owner, project, access, sensitive keys,
 * expiry (or `never`) and prefix, and never the token, its hash or its name.
 *
 * @throws AccessDeniedError, with no scope, without the permission.
 * @throws AuthInputError `name`, `access`, `expiresInDays`, `noExpiry`, `projectId` or
 * `sensitivePermissions` for a value that is not acceptable. It names the field and never
 * the value.
 * @throws ApiTokensDisabledError, ApiSensitiveTokensDisabledError,
 * NotASensitivePermissionError and TokenExceedsOwnAccessError, as above. Nothing is
 * written.
 * @throws AuthStateError `installation-missing` before the installation row exists.
 * @throws RecordWriteError when the database refuses a write; it carries the SQLSTATE and
 * constraint name only, never the token, its hash or the name.
 */
export async function createApiToken(
  tx: Tx,
  actor: ApiTokenActor,
  organisationId: string,
  input: CreateApiTokenInput,
  now: Date,
): Promise<{ apiToken: ApiTokenView; token: string }> {
  const checked = checkedCreate(input);
  return guardedAuth('api_token', 'insert', () =>
    // A savepoint: a failure leaves no token and no event.
    tx.transaction(async (inner) => {
      await requirePermission(
        inner,
        actor.userId,
        organisationId,
        API_TOKENS_PERMISSION,
      );
      // Before the switches are read, so this cannot race a switch being turned off.
      await lockOrganisationChanges(inner, organisationId);
      const switches = await readApiTokenSwitches(inner, organisationId);
      if (!switches.personalTokens) throw new ApiTokensDisabledError();
      if (
        checked.projectId !== null &&
        !(await userReachesProject(
          inner,
          actor.userId,
          organisationId,
          checked.projectId,
        ))
      ) {
        throw new AuthInputError('projectId');
      }
      if (checked.sensitivePermissions.length > 0) {
        if (!switches.sensitive) throw new ApiSensitiveTokensDisabledError();
        await checkSensitiveScope(inner, actor.userId, organisationId, checked);
      }

      const expiresAt =
        checked.days === null
          ? null
          : new Date(now.getTime() + checked.days * DAY_MS);
      const made = await insertWithFreshToken(inner, {
        originServer: await serverId(inner),
        organisationId,
        userId: actor.userId,
        projectId: checked.projectId,
        name: checked.name,
        access: checked.access,
        sensitivePermissions: [...checked.sensitivePermissions],
        expiresAt,
        createdAt: now,
        updatedAt: now,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.apiTokenCreated,
        action: 'create',
        actor: { type: 'user', id: actor.userId },
        targetType: 'api_token',
        targetId: made.row.id,
        organisationId,
        details: {
          userId: actor.userId,
          projectId: checked.projectId,
          access: checked.access,
          sensitivePermissions: [...checked.sensitivePermissions]
            .sort()
            .join(','),
          expiresAt: expiresAt === null ? 'never' : expiresAt.toISOString(),
          prefix: made.row.prefix,
        },
        occurredAt: now,
      });
      return { apiToken: toView(made.row), token: made.token };
    }),
  );
}

/**
 * Lists the person's own tokens in the organisation that still work at `now`, newest
 * first: not revoked, and not past their end. Never a token or its hash: the token was
 * shown once, when it was made. Needs `api:tokens` in the organisation.
 *
 * @throws AccessDeniedError, with no scope, without the permission.
 * @throws RecordWriteError when the database fails.
 */
export function listOwnApiTokens(
  tx: Tx,
  actor: ApiTokenActor,
  organisationId: string,
  now: Date,
): Promise<ApiTokenView[]> {
  return guardedAuth('api_token', 'select', async () => {
    await requirePermission(
      tx,
      actor.userId,
      organisationId,
      API_TOKENS_PERMISSION,
    );
    const rows = await tx
      .select(viewColumns)
      .from(apiToken)
      .where(
        and(
          eq(apiToken.organisationId, organisationId),
          eq(apiToken.userId, actor.userId),
          liveAt(now),
        ),
      )
      .orderBy(desc(apiToken.createdAt), desc(apiToken.id));
    return rows.map(toView);
  });
}

/**
 * Lists every token of the organisation that still works at `now`, newest first, with the
 * name of the person who owns each. Metadata only, as for the owner: never a token or its
 * hash. Needs `api:manage` in the organisation.
 *
 * @throws AccessDeniedError, with no scope, without the permission.
 * @throws RecordWriteError when the database fails.
 */
export function listOrganisationApiTokens(
  tx: Tx,
  actor: ApiTokenActor,
  organisationId: string,
  now: Date,
): Promise<OrganisationApiTokenView[]> {
  return guardedAuth('api_token', 'select', async () => {
    await requirePermission(
      tx,
      actor.userId,
      organisationId,
      API_MANAGE_PERMISSION,
    );
    const rows = await tx
      .select({ ...viewColumns, ownerDisplayName: user.displayName })
      .from(apiToken)
      .innerJoin(user, eq(user.id, apiToken.userId))
      .where(and(eq(apiToken.organisationId, organisationId), liveAt(now)))
      .orderBy(desc(apiToken.createdAt), desc(apiToken.id));
    return rows.map((row) => ({
      ...toView(row),
      ownerDisplayName: row.ownerDisplayName,
    }));
  });
}

/**
 * Revokes one live token, by one conditional UPDATE, so two revokes of one token end with
 * one revocation and a not found for the other: the second waits for the row, then finds
 * it no longer live. `owner`, when given, limits it to that person's tokens. Audited as
 * `auth.api-token-revoked` with the reason `manual` and the owner.
 *
 * @throws RecordNotFoundError when no live token of the organisation (and owner) has this
 * id: unknown, malformed, another organisation's, revoked, expired, or not the owner's.
 * The same answer for all, so ids cannot be probed.
 */
async function revokeOne(
  tx: Tx,
  owner: string | null,
  actorId: string,
  organisationId: string,
  tokenId: string,
  now: Date,
): Promise<void> {
  if (!UUID_SHAPE.test(tokenId)) {
    throw new RecordNotFoundError('api_token', tokenId);
  }
  const [row] = await tx
    .update(apiToken)
    .set({
      revokedAt: now,
      revokeReason: 'manual',
      revokedBy: actorId,
      updatedAt: now,
      updatedBy: actorId,
      version: sql`${apiToken.version} + 1`,
    })
    .where(
      and(
        eq(apiToken.id, tokenId),
        eq(apiToken.organisationId, organisationId),
        owner === null ? undefined : eq(apiToken.userId, owner),
        liveAt(now),
      ),
    )
    .returning({ id: apiToken.id, userId: apiToken.userId });
  if (!row) throw new RecordNotFoundError('api_token', tokenId);
  await recordAuthAudit(tx, {
    category: AUTH_AUDIT.apiTokenRevoked,
    action: 'revoke',
    actor: { type: 'user', id: actorId },
    targetType: 'api_token',
    targetId: row.id,
    organisationId,
    details: { reason: 'manual', userId: row.userId },
    occurredAt: now,
  });
}

/**
 * Revokes one of the person's own tokens, so it stops working at once. Needs `api:tokens`
 * in the organisation. Another person's token, an unknown one and one that is not live
 * (revoked, or past its end) are the same `RecordNotFoundError`, so a member cannot tell a
 * token that exists from one that does not. Audited as `auth.api-token-revoked`.
 *
 * @throws AccessDeniedError, with no scope, without the permission.
 * @throws RecordNotFoundError when the person has no live token with this id here.
 * @throws RecordWriteError when the database refuses a write; it carries the SQLSTATE only.
 */
export function revokeOwnApiToken(
  tx: Tx,
  actor: ApiTokenActor,
  organisationId: string,
  tokenId: string,
  now: Date,
): Promise<void> {
  return guardedAuth('api_token', 'update', () =>
    tx.transaction(async (inner) => {
      await requirePermission(
        inner,
        actor.userId,
        organisationId,
        API_TOKENS_PERMISSION,
      );
      await revokeOne(
        inner,
        actor.userId,
        actor.userId,
        organisationId,
        tokenId,
        now,
      );
    }),
  );
}

/**
 * Revokes any live token of the organisation, whoever owns it, so it stops working at
 * once. Needs `api:manage` in the organisation. Audited as `auth.api-token-revoked` with
 * the administrator as the actor and the owner in the details.
 *
 * @throws AccessDeniedError, with no scope, without the permission.
 * @throws RecordNotFoundError when the organisation has no live token with this id.
 * @throws RecordWriteError when the database refuses a write; it carries the SQLSTATE only.
 */
export function revokeAnyApiToken(
  tx: Tx,
  actor: ApiTokenActor,
  organisationId: string,
  tokenId: string,
  now: Date,
): Promise<void> {
  return guardedAuth('api_token', 'update', () =>
    tx.transaction(async (inner) => {
      await requirePermission(
        inner,
        actor.userId,
        organisationId,
        API_MANAGE_PERMISSION,
      );
      await revokeOne(inner, null, actor.userId, organisationId, tokenId, now);
    }),
  );
}

/**
 * The one entry for `DELETE /organisations/:organisationId/api-tokens/:tokenId`: a person
 * who holds `api:manage` revokes any live token of the organisation (`revokeAnyApiToken`),
 * and a person who holds only `api:tokens` revokes their own (`revokeOwnApiToken`), and
 * meets a not found for anyone else's, so it cannot be used to find out whose a token is.
 * A person who holds neither is refused.
 *
 * @throws AccessDeniedError, with no scope, for a person who holds neither permission.
 * @throws RecordNotFoundError when no live token that the person may revoke has this id.
 * @throws RecordWriteError when the database refuses a write; it carries the SQLSTATE only.
 */
export function revokeApiToken(
  tx: Tx,
  actor: ApiTokenActor,
  organisationId: string,
  tokenId: string,
  now: Date,
): Promise<void> {
  return guardedAuth('api_token', 'update', () =>
    tx.transaction(async (inner) => {
      const manages =
        UUID_SHAPE.test(actor.userId) &&
        UUID_SHAPE.test(organisationId) &&
        (await hasOrganisationPermission(
          inner,
          actor.userId,
          organisationId,
          API_MANAGE_PERMISSION,
        ));
      if (manages) {
        await revokeOne(
          inner,
          null,
          actor.userId,
          organisationId,
          tokenId,
          now,
        );
        return;
      }
      await requirePermission(
        inner,
        actor.userId,
        organisationId,
        API_TOKENS_PERMISSION,
      );
      await revokeOne(
        inner,
        actor.userId,
        actor.userId,
        organisationId,
        tokenId,
        now,
      );
    }),
  );
}

/**
 * Revokes every token that still works and matches `filter`, and returns how many. The
 * rows are locked in id order first (`FOR UPDATE`) and changed after, so two bulk
 * revocations that overlap (a switch turned off while a reset link is used) take the rows
 * in one order and cannot deadlock. A token that is already revoked or past its end is
 * left as it is. Writes no audit event: the caller's own event counts them.
 */
async function revokeLiveTokens(
  tx: Tx,
  filter: SQL,
  reason: ApiTokenRevokeReason,
  revokedBy: string | null,
  now: Date,
): Promise<number> {
  const locked = await tx
    .select({ id: apiToken.id })
    .from(apiToken)
    .where(and(filter, liveAt(now)))
    .orderBy(asc(apiToken.id))
    .for('update');
  if (locked.length === 0) return 0;
  await tx
    .update(apiToken)
    .set({
      revokedAt: now,
      revokeReason: reason,
      revokedBy,
      updatedAt: now,
      updatedBy: revokedBy,
      version: sql`${apiToken.version} + 1`,
    })
    .where(
      inArray(
        apiToken.id,
        locked.map((row) => row.id),
      ),
    );
  return locked.length;
}

/**
 * Revokes every live token of one person, in any organisation, with the reason given, and
 * returns how many. For an admin reset link being used (`access-reset`, in
 * `useAccessReset`, in the same transaction and counted in its audit event) and, when
 * member management comes (P-04b), for a membership that ends (`membership-ended`). A
 * person whose access was reset, or who left, must not keep a script that still works.
 * Writes no audit event of its own, and checks no permission: the caller has decided, and
 * records the count. Never touches a token that is already revoked or past its end.
 *
 * TODO(P-04b): member removal calls this with `membership-ended`. Until then a token whose
 * owner's membership is not active simply fails (`authenticateApiToken`), which stops it
 * for as long as the membership stays inactive; the revocation will make that permanent,
 * so a membership that is made active again does not bring the token back.
 *
 * @throws RecordWriteError when the database refuses a write; it carries the SQLSTATE only.
 */
export function revokeApiTokensOfUser(
  tx: Tx,
  userId: string,
  reason: Extract<ApiTokenRevokeReason, 'access-reset' | 'membership-ended'>,
  now: Date,
): Promise<number> {
  return guardedAuth('api_token', 'update', () =>
    revokeLiveTokens(tx, eq(apiToken.userId, userId), reason, null, now),
  );
}

/**
 * The organisation's two switches for personal API tokens, as they are now: both off for an
 * organisation that has never set them. Needs `api:manage` in the organisation, which is
 * also what changes them (`setApiTokenSwitches`). The sensitive switch is the effective
 * one: it reads off while tokens are off.
 *
 * @throws AccessDeniedError, with no scope, without the permission.
 * @throws RecordWriteError when the database fails; it carries the SQLSTATE only.
 */
export function getApiTokenSwitches(
  tx: Tx,
  actor: ApiTokenActor,
  organisationId: string,
): Promise<ApiTokenSwitches> {
  return guardedAuth('setting_value', 'select', async () => {
    await requirePermission(
      tx,
      actor.userId,
      organisationId,
      API_MANAGE_PERMISSION,
    );
    return readApiTokenSwitches(tx, organisationId);
  });
}

/**
 * Turns the organisation's two switches for personal API tokens to the values given, and
 * answers what they are now and how many tokens it revoked. Needs `api:manage` in the
 * organisation. The sensitive switch can only be on while personal tokens are, so `sensitive:
 * true` with `personalTokens: false` is a bad request; turning tokens off also turns the
 * sensitive switch off.
 *
 * Turning a switch off takes effect at once, in this transaction. Personal tokens off
 * revokes every live token of the organisation, with the reason `switch-off`; sensitive off
 * revokes every live token that has a sensitive scope. Turning one on restores nothing
 * (SC-10: "Switching off takes effect at once and invalidates existing tokens"). Each
 * switch that changes is written through the write helper as a setting of the organisation
 * (a change event of its own) and audited once as `auth.api-token-switch-changed` with the
 * switch, whether it is on, and how many tokens it revoked. A call that changes nothing
 * writes nothing.
 *
 * The organisation's change counter is taken first (`lockOrganisationChanges`; CLAUDE.md,
 * Data rules), so this and the making of a token (`createApiToken`) queue on it: a token is
 * made and then revoked, or refused.
 *
 * @throws AccessDeniedError, with no scope, without the permission.
 * @throws AuthInputError `personalTokens` or `sensitive` for a value that is not a
 * boolean, and `sensitive` for the sensitive switch on with tokens off. Nothing is written.
 * @throws AuthStateError `installation-missing` before the installation row exists.
 * @throws RecordWriteError when the database refuses a write; it carries the SQLSTATE and
 * constraint name only.
 */
export async function setApiTokenSwitches(
  tx: Tx,
  actor: ApiTokenActor,
  organisationId: string,
  input: ApiTokenSwitchesInput,
  now: Date,
): Promise<ApiTokenSwitchesResult> {
  if (typeof input.personalTokens !== 'boolean') {
    throw new AuthInputError('personalTokens');
  }
  if (typeof input.sensitive !== 'boolean') {
    throw new AuthInputError('sensitive');
  }
  if (input.sensitive && !input.personalTokens) {
    throw new AuthInputError('sensitive');
  }
  const wanted = {
    personalTokens: input.personalTokens,
    sensitive: input.sensitive,
  };
  return guardedAuth('setting_value', 'update', () =>
    // A savepoint: a failure leaves no setting, no revocation and no event.
    tx.transaction(async (inner) => {
      await requirePermission(
        inner,
        actor.userId,
        organisationId,
        API_MANAGE_PERMISSION,
      );
      // The counter first, through the write helper's own function: every writer of a
      // record of the organisation takes it before any row lock.
      await lockOrganisationChanges(inner, organisationId);
      const rows = await apiTokenSettingRows(inner, organisationId);
      const before = switchesFromRows(rows);

      const ctx: WriteContext = {
        actor: { type: 'user', id: actor.userId },
        originServer: await serverId(inner),
        clock: () => now,
      };
      for (const [key, value] of [
        [API_PERSONAL_TOKENS_SETTING, wanted.personalTokens],
        [API_SENSITIVE_TOKENS_SETTING, wanted.sensitive],
      ] as const) {
        const stored = rows.find((row) => row.key === key);
        if (stored === undefined) {
          // Off is a row that is not there, so there is nothing to write for off.
          if (value) {
            await insertRecord(
              inner,
              settingValue,
              {
                organisationId,
                ownerOrgId: organisationId,
                layer: 'org',
                projectId: null,
                key,
                value: true,
              },
              ctx,
            );
          }
        } else if (stored.on !== value) {
          await updateRecord(
            inner,
            settingValue,
            stored.id,
            stored.version,
            { value },
            ctx,
          );
        }
      }

      // Tokens off ends every live token; it comes first, so that the sensitive switch,
      // if it goes off with it, finds nothing more to revoke and is counted once.
      const byTokens =
        before.personalTokens && !wanted.personalTokens
          ? await revokeLiveTokens(
              inner,
              eq(apiToken.organisationId, organisationId),
              'switch-off',
              actor.userId,
              now,
            )
          : 0;
      const bySensitive =
        before.sensitive && !wanted.sensitive
          ? await revokeLiveTokens(
              inner,
              and(
                eq(apiToken.organisationId, organisationId),
                sql`cardinality(${apiToken.sensitivePermissions}) > 0`,
              )!,
              'switch-off',
              actor.userId,
              now,
            )
          : 0;

      for (const change of [
        {
          name: 'personal-tokens',
          was: before.personalTokens,
          is: wanted.personalTokens,
          revoked: byTokens,
        },
        {
          name: 'sensitive',
          was: before.sensitive,
          is: wanted.sensitive,
          revoked: bySensitive,
        },
      ]) {
        if (change.was === change.is) continue;
        await recordAuthAudit(inner, {
          category: AUTH_AUDIT.apiTokenSwitchChanged,
          action: 'change',
          actor: { type: 'user', id: actor.userId },
          targetType: 'organisation',
          targetId: organisationId,
          organisationId,
          details: {
            switch: change.name,
            enabled: change.is,
            revoked: change.revoked,
          },
          occurredAt: now,
        });
      }
      return { ...wanted, revoked: byTokens + bySensitive };
    }),
  );
}

/** What a token's lookup found, or why it did not work. */
type Outcome =
  | {
      readonly ok: true;
      readonly id: string;
      readonly credential: TokenCredential;
      readonly user: SessionUser;
    }
  | {
      readonly ok: false;
      readonly reason: ApiTokenFailureReason;
      /** The token the request named, when it is one that exists. */
      readonly known: {
        readonly id: string;
        readonly organisationId: string;
      } | null;
    };

/**
 * Finds the live token for a raw value and the person who owns it, and answers what the
 * token may do (`credential`) and who it acts as (`user`). Takes the token as the
 * capability and checks no permission. A token works only when all of these hold: it is
 * not revoked and not past its end (a token that ends exactly at `now` has ended); the
 * organisation's switch for personal tokens is on, and, if the token has a sensitive
 * scope, so is the sensitive switch (so a token is refused even if a revocation was
 * missed); its owner's account is active; its owner's membership of the organisation
 * is active and not deleted; and the request does not name another organisation than
 * the token's in its path (`request.organisationId`).
 *
 * Every other case is the same `ApiTokenInvalidError`, whether the token is unknown,
 * expired, revoked or refused for any of the other reasons, and a value that cannot be a
 * token is refused without being looked up. The cause goes into the audit event
 * `auth.api-token-auth-failed` (from the system, the token's id and organisation when it
 * is one that exists, a reason code, and never any part of the value that was sent),
 * which is written before the error is thrown: the caller catches it inside its
 * transaction and commits, so the event survives (CLAUDE.md, Data rules). A caller that
 * says `request.auditFailure: false` gets the same error and no event.
 *
 * A token that works has `last_used_at` written, at most once a minute, in one conditional
 * UPDATE like a session's, so a busy token is not a write per request. That is no edit of
 * the token: its version stays. Nothing else is written, and no event: the outside call
 * is audited after the response (`recordApiTokenCall`).
 *
 * @throws ApiTokenInvalidError for a token that is no good: one error for all.
 * @throws RecordWriteError when the database fails; it carries the SQLSTATE only, never
 * the token or its hash.
 */
export async function authenticateApiToken(
  tx: Tx,
  token: string,
  now: Date,
  request: AuthenticatingRequest = {},
): Promise<AuthenticatedApiToken> {
  // A value that is not shaped like a token is refused here, without a lookup.
  const secret =
    typeof token === 'string' ? TOKEN_SHAPE.exec(token)?.[1] : undefined;
  const hash = secret === undefined ? null : hashToken(secret);
  const outcome = await guardedAuth(
    'api_token',
    'select',
    async (): Promise<Outcome> => {
      const refuse = (
        reason: ApiTokenFailureReason,
        known: { id: string; organisationId: string } | null,
      ): Outcome => ({ ok: false, reason, known });
      if (hash === null) return refuse('unknown', null);
      const [row] = await tx
        .select({
          id: apiToken.id,
          organisationId: apiToken.organisationId,
          projectId: apiToken.projectId,
          access: apiToken.access,
          sensitivePermissions: apiToken.sensitivePermissions,
          expiresAt: apiToken.expiresAt,
          revokedAt: apiToken.revokedAt,
          lastUsedAt: apiToken.lastUsedAt,
          user: SESSION_USER_COLUMNS,
          userDeletedAt: user.deletedAt,
          membershipStatus: orgMembership.status,
          membershipDeletedAt: orgMembership.deletedAt,
        })
        .from(apiToken)
        .innerJoin(user, eq(user.id, apiToken.userId))
        .leftJoin(
          orgMembership,
          and(
            eq(orgMembership.organisationId, apiToken.organisationId),
            eq(orgMembership.userId, apiToken.userId),
          ),
        )
        .where(eq(apiToken.tokenHash, hash))
        .limit(1);
      if (row === undefined) return refuse('unknown', null);
      const known = { id: row.id, organisationId: row.organisationId };
      if (row.revokedAt !== null) return refuse('revoked', known);
      if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
        return refuse('expired', known);
      }
      if (row.userDeletedAt !== null || row.user.status !== 'active') {
        return refuse('user-not-active', known);
      }
      // TODO(P-04b): member removal revokes the owner's tokens (`membership-ended`).
      // Until then this is what stops them: a membership that is not active is no access.
      if (
        row.membershipStatus !== 'active' ||
        row.membershipDeletedAt !== null
      ) {
        return refuse('membership-not-active', known);
      }
      const switches = await readApiTokenSwitches(tx, row.organisationId);
      if (!switches.personalTokens) return refuse('switch-off', known);
      if (row.sensitivePermissions.length > 0 && !switches.sensitive) {
        return refuse('sensitive-switch-off', known);
      }
      // The request is for an organisation, and the token is another's. Last, so that
      // the audit trail names the token's own trouble first when it has any.
      if (
        request.organisationId !== undefined &&
        request.organisationId.toLowerCase() !== row.organisationId
      ) {
        return refuse('wrong-organisation', known);
      }
      // One conditional UPDATE, so two requests that both see a stale value write once.
      const due = new Date(now.getTime() - SESSION_DEFAULTS.slideIntervalMs);
      await tx
        .update(apiToken)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(
          and(
            eq(apiToken.id, row.id),
            isNull(apiToken.revokedAt),
            or(isNull(apiToken.lastUsedAt), lte(apiToken.lastUsedAt, due)),
          ),
        );
      return {
        ok: true,
        id: row.id,
        credential: {
          kind: 'token',
          tokenId: row.id,
          organisationId: row.organisationId,
          projectId: row.projectId,
          access: row.access,
          sensitivePermissions: [...row.sensitivePermissions],
        },
        user: row.user,
      };
    },
  );
  if (outcome.ok) {
    return { credential: outcome.credential, user: outcome.user };
  }
  if (request.auditFailure !== false) {
    await guardedAuth('audit_event', 'insert', () =>
      recordAuthAudit(tx, {
        category: AUTH_AUDIT.apiTokenAuthFailed,
        action: 'authenticate',
        actor: { type: 'system', id: null },
        targetType: outcome.known === null ? null : 'api_token',
        targetId: outcome.known?.id ?? null,
        organisationId: outcome.known?.organisationId ?? null,
        details: { reason: outcome.reason },
        occurredAt: now,
      }),
    );
  }
  throw new ApiTokenInvalidError(outcome.reason);
}

/** What the API tells the audit log about one outside call. */
export type ApiTokenCall = {
  /** The token's owner. */
  readonly userId: string;
  /** The HTTP method: upper case, one of the seven the server knows. */
  readonly method: string;
  /** The route pattern, such as `/api/v1/organisations/:organisationId/members`, never the URL. */
  readonly route: string;
  /** The status of the response. */
  readonly status: number;
  /** The request's id, so the event can be matched with the log line. */
  readonly requestId?: string | null;
};

/**
 * Writes the audit event of one outside call, made with a personal API token (SC-10,
 * decision D-68: every outside call is written to the audit log): `api.call`, from the
 * token, with the owner, the organisation, the method, the route pattern and the status
 * of the response. Never a query string, a body, a header, an address of the caller or the
 * token: the route is the pattern that matched and not the path that was asked for, so
 * what is in a URL never reaches the log. The API calls it after the response is sent.
 * Checks no permission.
 *
 * @throws AuthInputError `userId`, `method`, `route` or `status` for a value the server
 * could not have made. Nothing is written.
 * @throws RecordWriteError when the database refuses the write; it carries the SQLSTATE
 * only.
 */
export async function recordApiTokenCall(
  tx: Tx,
  credential: TokenCredential,
  call: ApiTokenCall,
  now: Date,
): Promise<void> {
  if (typeof call.userId !== 'string' || !UUID_SHAPE.test(call.userId)) {
    throw new AuthInputError('userId');
  }
  if (typeof call.method !== 'string' || !HTTP_METHODS.has(call.method)) {
    throw new AuthInputError('method');
  }
  if (
    typeof call.route !== 'string' ||
    call.route.length < 1 ||
    call.route.length > MAX_ROUTE_LENGTH
  ) {
    throw new AuthInputError('route');
  }
  if (
    typeof call.status !== 'number' ||
    !Number.isInteger(call.status) ||
    call.status < 100 ||
    call.status > 599
  ) {
    throw new AuthInputError('status');
  }
  await guardedAuth('audit_event', 'insert', () =>
    recordAuthAudit(tx, {
      category: AUTH_AUDIT.apiCall,
      action: 'call',
      actor: { type: 'token', id: credential.tokenId },
      targetType: 'api_token',
      targetId: credential.tokenId,
      organisationId: credential.organisationId,
      details: {
        userId: call.userId,
        method: call.method,
        route: call.route,
        status: call.status,
      },
      requestId: call.requestId ?? null,
      occurredAt: now,
    }),
  );
}
