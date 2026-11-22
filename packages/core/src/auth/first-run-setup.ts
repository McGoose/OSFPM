import { and, eq, isNull } from 'drizzle-orm';
import { newId } from '../db/ids.js';
import {
  installation,
  orgMembership,
  orgMembershipRole,
  organisation,
} from '../db/schema/index.js';
import { insertRecord, type Tx, type WriteContext } from '../db/write.js';
import {
  ADMINISTRATOR_ROLE_KEY,
  createAdministratorRole,
} from './administrator-role.js';
import { AuthInputError, AuthStateError } from './errors.js';
import { normaliseEmail } from './login-user.js';
import { PASSWORD_REFUSALS, type PasswordRefusal } from './password-policy.js';
import { setPassword } from './password-service.js';
import type { SessionUser } from './sessions.js';
import {
  consumeSetupCode,
  lockInstallation,
  recordSetupCodeRefused,
} from './setup-code.js';
import { AUTH_AUDIT, guardedAuth, isOneOf, recordAuthAudit } from './shared.js';
import { createUser, isEmailShaped } from './users.js';

/**
 * First-run setup (SC-10, decision D-56, Q1): whoever holds the setup code the
 * server printed at start-up creates the first organisation, its Administrator
 * role and the first administrator, in one transaction. Until then a fresh
 * install has no one who can sign in. The API's setup route adds the session and
 * the cookie.
 */

/**
 * The locale and time zone of an organisation made without them, and of its first
 * administrator. Neutral on purpose: English with no region, and UTC, which is
 * how timestamps are kept (CLAUDE.md, Data rules). The organisation sets its own
 * later. Not a legal or financial number.
 */
export const SETUP_ORGANISATION_DEFAULTS = {
  locale: 'en',
  timeZone: 'UTC',
} as const;

/** The longest organisation name or display name setup takes. */
const MAX_NAME_LENGTH = 200;

/** The longest slug: what fits in a URL path comfortably. */
const MAX_SLUG_LENGTH = 63;

/** The slug of an organisation whose name has no letter or digit a slug can use. */
const FALLBACK_SLUG = 'organisation';

/** What the database's own checks require: two upper case letters, and three. */
const COUNTRY_CODE = /^[A-Z]{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

/** A time zone name starts with a letter: `+01:00` is an offset, not an IANA zone. */
const ZONE_NAME = /^[A-Za-z]/;

/**
 * The BCP 47 form of a language tag, such as `en-GB` for `en-gb`, or null when
 * `value` is not a valid tag (an empty string, `en_GB` with its underscore, words
 * with spaces). Uses the platform's own parser, so the rules are the standard's.
 * Reads nothing; anyone may call it.
 */
export function normaliseLocale(value: string): string | null {
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The time zones the platform lists, by lower case name, so a zone typed in the
 * wrong case can be given its right spelling. The list holds the platform's own
 * spelling, which for a few zones is an older alias (`Europe/Kiev`), and lacks
 * `UTC`; so it is used to correct the case of a name, never to replace one.
 */
const LISTED_ZONES: ReadonlyMap<string, string> = new Map(
  Intl.supportedValuesOf('timeZone').map((zone) => [zone.toLowerCase(), zone]),
);

/**
 * The name of an IANA time zone as it should be stored, or null when `value` is
 * not a time zone the platform knows. The name is kept as it was given, so
 * `Europe/Kyiv` stays `Europe/Kyiv` although the platform's own spelling is the
 * older alias `Europe/Kiev`; only its case is corrected when the platform lists
 * the zone (`europe/london` becomes `Europe/London`), and `utc` in any case
 * becomes `UTC`. An offset such as `+01:00` is refused: a zone is a place with a
 * history, not a fixed offset. Reads nothing; anyone may call it.
 */
export function normaliseTimeZone(value: string): string | null {
  if (!ZONE_NAME.test(value)) return null;
  try {
    // Throws a RangeError for a name the platform does not know.
    new Intl.DateTimeFormat('en', { timeZone: value });
  } catch {
    return null;
  }
  if (value.toUpperCase() === 'UTC') return 'UTC';
  return LISTED_ZONES.get(value.toLowerCase()) ?? value;
}

/**
 * The slug of an organisation, made from its name: lower case, with accents
 * dropped (a letter with a combining accent, or composed, comes out the same),
 * every run of anything else one hyphen, at most 63 characters, never starting or
 * ending in a hyphen. A name with no letter or digit in it, such as one written in
 * a script this form cannot spell, becomes `organisation`. Reads nothing; anyone
 * may call it.
 */
export function slugFromName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug === '' ? FALLBACK_SLUG : slug;
}

/** What setup is given: the code, the organisation and the first administrator. */
export type FirstRunSetupInput = {
  /** The setup code the server printed, as typed. Any spelling works. */
  readonly code: string;
  readonly organisation: {
    readonly name: string;
    /** ISO 3166-1 alpha-2, in capitals. */
    readonly country: string;
    /** ISO 4217, in capitals. */
    readonly baseCurrency: string;
    /** BCP 47. `SETUP_ORGANISATION_DEFAULTS` when left out. */
    readonly locale?: string;
    /** An IANA time zone. `SETUP_ORGANISATION_DEFAULTS` when left out. */
    readonly timeZone?: string;
  };
  readonly admin: {
    readonly email: string;
    readonly displayName: string;
    /**
     * The password, which the policy must accept. Left out, the account has no way
     * to sign in yet and `mustSecureAccount` is true: the first session may only
     * add a passkey or set a password.
     */
    readonly password?: string;
  };
};

/** The organisation setup made, as the caller shows it: no sensitive field. */
export type FirstRunOrganisation = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly country: string;
  readonly baseCurrency: string;
  readonly locale: string;
  readonly timeZone: string;
};

/**
 * What `completeFirstRunSetup` answers. A refusal is a returned value, not a
 * thrown error: `code-invalid` is one answer for every way a code can be no good
 * (unknown, expired, replaced, used, not shaped like one, or setup already
 * complete), so a caller learns nothing about which, and `password-refused` gives
 * the policy's reason, which the person setting the password is owed.
 */
export type FirstRunSetupResult =
  | {
      readonly ok: true;
      readonly user: SessionUser;
      readonly organisation: FirstRunOrganisation;
      /** True when no password was given: the session must secure the account first. */
      readonly mustSecureAccount: boolean;
    }
  | { readonly ok: false; readonly reason: 'code-invalid' }
  | {
      readonly ok: false;
      readonly reason: 'password-refused';
      readonly refusal: PasswordRefusal;
    };

/** The input after it was checked and put in the form it is stored in. */
type CheckedInput = {
  readonly code: string;
  readonly organisation: Omit<FirstRunOrganisation, 'id'>;
  readonly admin: {
    readonly email: string;
    readonly displayName: string;
    readonly password: string | undefined;
  };
};

/** The one answer for a code that is no good. */
const CODE_INVALID = { ok: false, reason: 'code-invalid' } as const;

/**
 * Checks the shape of what setup was given, before anything is written or the
 * code is looked at, and puts it in the form it is stored in. The API checks the
 * same with Zod; this is the service's own guard, so a caller that is not the API
 * gets a typed refusal and not a database error. Each refusal names the field and
 * never the value.
 */
function checked(input: FirstRunSetupInput): CheckedInput {
  const { organisation: org, admin } = input;
  const name = typeof org.name === 'string' ? org.name.trim() : '';
  if (name === '' || name.length > MAX_NAME_LENGTH) {
    throw new AuthInputError('organisation.name');
  }
  if (typeof org.country !== 'string' || !COUNTRY_CODE.test(org.country)) {
    throw new AuthInputError('organisation.country');
  }
  if (
    typeof org.baseCurrency !== 'string' ||
    !CURRENCY_CODE.test(org.baseCurrency)
  ) {
    throw new AuthInputError('organisation.baseCurrency');
  }
  const locale =
    org.locale === undefined
      ? SETUP_ORGANISATION_DEFAULTS.locale
      : typeof org.locale === 'string'
        ? normaliseLocale(org.locale)
        : null;
  if (locale === null) throw new AuthInputError('organisation.locale');
  const timeZone =
    org.timeZone === undefined
      ? SETUP_ORGANISATION_DEFAULTS.timeZone
      : typeof org.timeZone === 'string'
        ? normaliseTimeZone(org.timeZone)
        : null;
  if (timeZone === null) throw new AuthInputError('organisation.timeZone');
  const email =
    typeof admin.email === 'string' ? normaliseEmail(admin.email) : '';
  if (!isEmailShaped(email)) throw new AuthInputError('admin.email');
  const displayName =
    typeof admin.displayName === 'string' ? admin.displayName.trim() : '';
  if (displayName === '' || displayName.length > MAX_NAME_LENGTH) {
    throw new AuthInputError('admin.displayName');
  }
  if (admin.password !== undefined && typeof admin.password !== 'string') {
    throw new AuthInputError('admin.password');
  }
  return {
    code: input.code,
    organisation: {
      slug: slugFromName(name),
      name,
      country: org.country,
      baseCurrency: org.baseCurrency,
      locale,
      timeZone,
    },
    admin: { email, displayName, password: admin.password },
  };
}

/** Thrown inside the savepoint to undo every step so far, and carried out to answer a refusal. */
class SetupRefused extends Error {
  constructor(readonly answer: Exclude<FirstRunSetupResult, { ok: true }>) {
    super('First-run setup was refused');
    this.name = 'SetupRefused';
  }
}

/**
 * The steps of setup, in the caller's savepoint. A refusal is returned, and the
 * caller undoes the savepoint; anything the database refuses is thrown.
 *
 * The order is the user first, then the organisation. The write helper stamps
 * `created_by` with its acting user, which is a foreign key to `user`, so the
 * person who is setting up exists before the first tenant row is written, and is
 * the actor of every change event after it. The user is an install-level row and
 * needs no organisation, so that order is open. Lock order: the installation row
 * (taken first, by `lockInstallation`), then the setup code row, then the user
 * row; only then the organisation, whose change counter is taken after the row
 * (the write helper's order for a new organisation). No project is touched, and
 * no other writer can reach a record of an organisation that is not committed.
 */
async function runSetup(
  tx: Tx,
  input: CheckedInput,
  now: Date,
): Promise<FirstRunSetupResult> {
  const server = await lockInstallation(tx);
  if (!server) throw new AuthStateError('installation-missing');
  // Complete already: the same answer as a code that does not work.
  if (server.setupCompletedAt !== null) return CODE_INVALID;
  if (!(await consumeSetupCode(tx, input.code, now))) return CODE_INVALID;

  const org = input.organisation;
  const admin = await createUser(tx, {
    email: input.admin.email,
    displayName: input.admin.displayName,
    locale: org.locale,
    timezone: org.timeZone,
    status: 'active',
    now,
  });
  if (input.admin.password !== undefined) {
    const set = await setPassword(tx, {
      userId: admin.id,
      newPassword: input.admin.password,
      now,
    });
    if (!set.ok) {
      if (isOneOf(PASSWORD_REFUSALS, set.reason)) {
        return { ok: false, reason: 'password-refused', refusal: set.reason };
      }
      // A new account has no password to change and no session, so the policy is
      // the only refusal there can be.
      throw new Error('A new account cannot owe a current password');
    }
  }

  const ctx: WriteContext = {
    originServer: server.id,
    clock: () => now,
    actor: { type: 'user', id: admin.id },
  };
  const actor = { type: 'user', id: admin.id } as const;
  const organisationId = newId();
  const created = await insertRecord(
    tx,
    organisation,
    {
      id: organisationId,
      organisationId,
      ownerOrgId: organisationId,
      slug: org.slug,
      name: org.name,
      country: org.country,
      defaultLocale: org.locale,
      defaultTimezone: org.timeZone,
      baseCurrency: org.baseCurrency,
      status: 'active',
    },
    ctx,
  );
  await recordAuthAudit(tx, {
    category: AUTH_AUDIT.organisationCreated,
    action: 'create',
    actor,
    targetType: 'organisation',
    targetId: organisationId,
    organisationId,
    occurredAt: now,
  });

  const administrator = await createAdministratorRole(tx, ctx, organisationId);
  await recordAuthAudit(tx, {
    category: AUTH_AUDIT.roleCreated,
    action: 'create',
    actor,
    targetType: 'role',
    targetId: administrator.id,
    organisationId,
    details: {
      key: ADMINISTRATOR_ROLE_KEY,
      permissions: administrator.permissions,
    },
    occurredAt: now,
  });

  const membership = await insertRecord(
    tx,
    orgMembership,
    {
      organisationId,
      ownerOrgId: organisationId,
      userId: admin.id,
      orgRole: 'owner',
      status: 'active',
    },
    ctx,
  );
  await insertRecord(
    tx,
    orgMembershipRole,
    {
      organisationId,
      ownerOrgId: organisationId,
      membershipId: membership.id,
      roleId: administrator.id,
    },
    ctx,
  );
  await recordAuthAudit(tx, {
    category: AUTH_AUDIT.membershipCreated,
    action: 'create',
    actor,
    targetType: 'org_membership',
    targetId: membership.id,
    organisationId,
    details: { orgRole: 'owner', roleKey: ADMINISTRATOR_ROLE_KEY },
    occurredAt: now,
  });

  // The conditional update is belt and braces: the row is locked, so setup is
  // known incomplete, but a second completion must never be possible.
  await tx
    .update(installation)
    .set({ setupCompletedAt: now })
    .where(
      and(
        eq(installation.id, server.id),
        isNull(installation.setupCompletedAt),
      ),
    );
  await recordAuthAudit(tx, {
    category: AUTH_AUDIT.setupCompleted,
    action: 'complete',
    actor,
    targetType: 'installation',
    targetId: server.id,
    organisationId,
    details: { organisationId, userId: admin.id },
    occurredAt: now,
  });

  return {
    ok: true,
    user: admin,
    organisation: {
      id: created.id,
      slug: created.slug,
      name: created.name,
      country: created.country,
      baseCurrency: created.baseCurrency,
      locale: created.defaultLocale,
      timeZone: created.defaultTimezone,
    },
    mustSecureAccount: input.admin.password === undefined,
  };
}

/**
 * Completes first-run setup: with the setup code the server printed, creates the
 * first organisation, its Administrator role (`createAdministratorRole`), the
 * first administrator and their owner membership, and marks setup complete, all
 * in one transaction, so a failure at any step leaves nothing. In order: locks the
 * `installation` row and refuses if setup is already complete; spends the code;
 * creates the user (active, with the address normalised) and, if a password was
 * given, sets it under the password policy; creates the organisation, its role
 * with its grants, and the membership (tier `owner`, active) linked to the role,
 * through the write helper with the new user as the acting user; sets
 * `installation.setup_completed_at`. The caller then makes the session (method
 * `setup`, scope `recovery` when `mustSecureAccount`) in the same transaction.
 *
 * Two setups at once with the same code: the first takes the installation row
 * lock, the second waits for it and then finds the code spent or setup complete,
 * so exactly one succeeds and the other gets `code-invalid`.
 *
 * Audited: `auth.setup-code-used`, `auth.user-created`, `auth.password-set` (when
 * a password was given), `auth.organisation-created`, `auth.role-created`,
 * `auth.membership-created` and `auth.setup-completed`, with ids and counts and
 * never a code, a password or an address. A refused code is audited as
 * `auth.setup-check-failed` (purpose `setup`); a refused password is not, because
 * no secret was guessed, and the person tries again with the same code, which the
 * refusal leaves unspent, as it does every other step that fails.
 *
 * A refusal is returned, not thrown, so the caller's transaction commits and the
 * audit event of a bad code is kept; the caller answers one way for every
 * `code-invalid`.
 *
 * @throws AuthInputError `organisation.name`, `organisation.country`,
 * `organisation.baseCurrency`, `organisation.locale`, `organisation.timeZone`,
 * `admin.email`, `admin.displayName` or `admin.password` for a value that is not
 * acceptable, before anything is written. It names the field and never the value.
 * @throws AuthStateError `installation-missing` before the installation row
 * exists.
 * @throws RecordWriteError when the database refuses a write, for example a
 * permission missing from the catalogue or an address already taken; it carries
 * the SQLSTATE and constraint name only, never a value.
 */
export async function completeFirstRunSetup(
  tx: Tx,
  input: FirstRunSetupInput,
  now: Date,
): Promise<FirstRunSetupResult> {
  const prepared = checked(input);
  try {
    return await tx.transaction(async (inner) => {
      const result = await guardedAuth('installation', 'update', () =>
        runSetup(inner, prepared, now),
      );
      // Thrown here, outside `guardedAuth`, so the savepoint is rolled back with
      // the user, the organisation and the spent code in it.
      if (!result.ok) throw new SetupRefused(result);
      return result;
    });
  } catch (error) {
    if (!(error instanceof SetupRefused)) throw error;
    // After the rollback, so the event is not undone with the rest.
    if (error.answer.reason === 'code-invalid') {
      await recordSetupCodeRefused(tx, 'setup', now);
    }
    return error.answer;
  }
}
