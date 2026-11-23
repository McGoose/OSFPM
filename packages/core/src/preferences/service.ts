import { and, eq, isNull, sql } from 'drizzle-orm';
import { AccessDeniedError } from '../access/access-denied-error.js';
import type { AccessCredential } from '../access/credential.js';
import { hasOrganisationPermission } from '../access/organisation-permission.js';
import { lockUser } from '../auth/shared.js';
import { person, user, userPreferences } from '../db/schema/index.js';
import {
  recordAudit,
  RecordNotFoundError,
  updateRecord,
  type Tx,
  type WriteContext,
} from '../db/write.js';
import { PEOPLE_EDIT_PERMISSION } from '../library/permissions.js';
import { PREFERENCES_AUDIT } from './audit.js';
import { UseAccountPreferencesError } from './errors.js';
import { guardedPreferences, isUuid } from './guard.js';
import {
  parsePreferences,
  preferencesSchema,
  withDefaults,
  type EffectivePreferences,
  type Preferences,
} from './schemas.js';

/**
 * Delivery preferences (decision D-69, P-02l2): how a person wants to receive information.
 * They are ordinary settings, not sensitive data, so nobody has to disclose anything to get
 * an accessible format, but they are not shown to everyone, as a courtesy: `easy-read` can
 * hint at something a person has not chosen to share. Three kinds of caller may read them:
 *
 * - the person, who has an account, reads and saves their own (`readOwnPreferences`,
 *   `saveOwnPreferences`), kept in `user_preferences`, which only this module writes;
 * - staff who hold `people:edit` in the person's organisation read and set those of a person
 *   with no account (`readPersonPreferences`, `savePersonPreferences`), kept in
 *   `person.communication_preferences` and written through the write helper;
 * - system code, such as the email module and the call sheets, calls `effectivePreferences`
 *   and nothing else, and gets what applies with the defaults filled in.
 *
 * Nothing else reads either place, and an ordinary read of a person never carries the
 * column (`source-scan.test.ts`). The preferences of a person who has an account are theirs
 * alone: staff are refused them, and the account's row wins over the person column.
 *
 * Nothing here logs. The audit events of an account holder's changes hold the user and the
 * names of the fields that changed, never a value.
 */

/** Who is acting, and on which server and clock. Always a user. */
export type PreferencesContext = {
  /** The user acting. */
  readonly userId: string;
  readonly requestId?: string | null;
  /** The server doing the work. */
  readonly originServer: string;
  readonly clock: () => Date;
  /**
   * How the request was authenticated. The staff calls pass it to their permission check, so
   * a personal API token is narrowed by its scope; left out, or a session's, nothing is
   * narrowed. The calls on one's own preferences are for a signed-in session and ignore it:
   * a token never takes a person's own way in.
   */
  readonly credential?: AccessCredential;
};

/** A person's preferences as a reader sees them: what was chosen, and what applies. */
export type PreferencesView = {
  /** Only the choices made. Empty when nothing was chosen. */
  readonly stored: Preferences;
  /** What applies: each choice, and the default for every field left out. */
  readonly effective: EffectivePreferences;
};

/** The view of a person's preferences kept by staff, with the version of the person to pass back when saving. */
export type PersonPreferencesView = PreferencesView & {
  /** The version of the person record, for `expectedVersion` of the next save. */
  readonly version: number;
};

/** The view of what was chosen. */
function viewOf(stored: Preferences): PreferencesView {
  return { stored, effective: withDefaults(stored) };
}

/**
 * What a stored value says, as preferences. Nothing is `{}`, and so is a value that no
 * longer fits the schema (a value a later release removed): the reader then gets the
 * defaults and does not fail, because a message that cannot be sent is worse than one sent
 * in the default format. Writes check the schema, so this only happens after a release.
 */
function storedPreferences(value: unknown): Preferences {
  if (value === null || value === undefined) return {};
  const parsed = preferencesSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/** The same JSON whatever the order of the keys, which PostgreSQL does not keep. */
function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );
}

/** The names of the fields whose choice differs between two schema-checked preferences, sorted. */
function changedFields(before: Preferences, after: Preferences): string[] {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  // Both were parsed by a strict schema, so every key is one of its own fields.
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((name) => canonical(a[name]) !== canonical(b[name]))
    .sort();
}

/** The write helper's context for `ctx`: a token's write is the token's in the change log, made for its owner. */
function writeContext(ctx: PreferencesContext): WriteContext {
  const shared = {
    originServer: ctx.originServer,
    clock: ctx.clock,
    requestId: ctx.requestId ?? null,
  };
  return ctx.credential?.kind === 'token'
    ? {
        ...shared,
        actor: { type: 'token', id: ctx.credential.tokenId },
        onBehalfOfUserId: ctx.userId,
      }
    : { ...shared, actor: { type: 'user', id: ctx.userId } };
}

/** The account's preferences row `FOR UPDATE`, which only a deletion of the row can have left empty. */
async function lockRow(tx: Tx, userId: string) {
  const [row] = await tx
    .select()
    .from(userPreferences)
    .where(
      and(
        eq(userPreferences.userId, userId),
        isNull(userPreferences.deletedAt),
      ),
    )
    .limit(1)
    .for('update');
  return row;
}

/**
 * Reads the signed-in person's own preferences: what they chose, and what applies with the
 * defaults. A person who chose nothing has none stored, and the answer says so, with the
 * defaults. Checks no permission: only `ctx.userId`'s own are ever read, and the route says
 * who is signed in. An account that is deleted has none.
 */
export async function readOwnPreferences(
  tx: Tx,
  ctx: PreferencesContext,
): Promise<PreferencesView> {
  if (!isUuid(ctx.userId)) return viewOf({});
  const [row] = await tx
    .select({ payload: userPreferences.payload })
    .from(userPreferences)
    .innerJoin(user, eq(user.id, userPreferences.userId))
    .where(
      and(
        eq(userPreferences.userId, ctx.userId),
        isNull(userPreferences.deletedAt),
        isNull(user.deletedAt),
      ),
    )
    .limit(1);
  return viewOf(storedPreferences(row?.payload));
}

/**
 * Saves the signed-in person's own preferences, replacing what was chosen: a field left out
 * is a choice cleared, and `{}` clears them all. The input is checked against the schema
 * first, and only the choices made are stored. The first save makes the row and writes
 * `preferences.saved` with the action `create`, a later one with `update`, each with the
 * names of the fields that changed and no value. A save that says what is stored writes
 * nothing: no new version and no event.
 *
 * It holds the user row `FOR KEY SHARE` while it works, which makes it one step with a
 * deletion of the account: the deletion takes that row `FOR UPDATE`, so a save that has
 * started finishes before the preferences are erased, and one that starts later finds the
 * account deleted and writes nothing. Without it a save could slip in after the erase and
 * leave a row for an account that is gone (CLAUDE.md, Data rules).
 *
 * @throws PreferencesInvalidError for input that breaks the schema; it lists paths and
 * codes, never values, and nothing was written.
 * @throws AuthStateError `user-not-found` for an account that is deleted or unknown.
 * @throws RecordWriteError when the database refuses a write; it carries the SQLSTATE and
 * constraint name only.
 */
export async function saveOwnPreferences(
  tx: Tx,
  ctx: PreferencesContext,
  input: unknown,
): Promise<PreferencesView> {
  const parsed = parsePreferences(input);
  const now = ctx.clock();
  const audit = (
    inner: Tx,
    action: 'create' | 'update',
    fields: readonly string[],
  ) =>
    recordAudit(inner, {
      actor: { type: 'user', id: ctx.userId },
      category: PREFERENCES_AUDIT.saved,
      action,
      targetType: 'user',
      targetId: ctx.userId,
      details: { changedFields: [...fields] },
      requestId: ctx.requestId ?? null,
      occurredAt: now,
    });
  return guardedPreferences('user_preferences', 'write', () =>
    // A savepoint: a refusal leaves no row and no event.
    tx.transaction(async (inner) => {
      await lockUser(inner, ctx.userId, { strength: 'key-share' });
      const [created] = await inner
        .insert(userPreferences)
        .values({
          originServer: ctx.originServer,
          userId: ctx.userId,
          payload: parsed as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        // Two first saves at once: the other one got there first, and this one updates.
        .onConflictDoNothing({ target: userPreferences.userId })
        .returning({ id: userPreferences.id });
      if (created !== undefined) {
        await audit(inner, 'create', changedFields({}, parsed));
        return viewOf(parsed);
      }
      const existing = await lockRow(inner, ctx.userId);
      if (existing === undefined) {
        throw new RecordNotFoundError('user_preferences', ctx.userId);
      }
      const before = storedPreferences(existing.payload);
      if (canonical(before) === canonical(parsed)) return viewOf(before);
      await inner
        .update(userPreferences)
        .set({
          payload: parsed,
          version: sql`${userPreferences.version} + 1`,
          updatedAt: now,
          updatedBy: ctx.userId,
        })
        .where(eq(userPreferences.id, existing.id));
      await audit(inner, 'update', changedFields(before, parsed));
      return viewOf(parsed);
    }),
  );
}

/**
 * Finds a person that staff may keep preferences for, and checks the caller may: a live
 * person, and the caller holds `people:edit` in the person's organisation (narrowed by a
 * token's credential). The answer is the same `AccessDeniedError`, with no scope, for a
 * person who does not exist, one who is deleted, one of another organisation and one the
 * caller may not edit, so ids cannot be probed.
 */
async function requireStaffOn(
  tx: Tx,
  ctx: PreferencesContext,
  personId: string,
) {
  const denied = () => new AccessDeniedError(PEOPLE_EDIT_PERMISSION);
  if (!isUuid(personId)) throw denied();
  const [found] = await tx
    .select({
      id: person.id,
      organisationId: person.organisationId,
      userId: person.userId,
      version: person.version,
      preferences: person.communicationPreferences,
    })
    .from(person)
    .where(and(eq(person.id, personId), isNull(person.deletedAt)))
    .limit(1);
  if (
    found === undefined ||
    !(await hasOrganisationPermission(
      tx,
      ctx.userId,
      found.organisationId,
      PEOPLE_EDIT_PERMISSION,
      ctx.credential,
    ))
  ) {
    throw denied();
  }
  return found;
}

/**
 * Reads the preferences staff keep for a person who has no account: what was recorded, and
 * what applies with the defaults, with the version of the person to pass to the next save.
 * Needs `people:edit` in the person's organisation. A person who has an account is refused
 * like any other denial: their preferences are theirs, read through `readOwnPreferences`.
 * Not audited: preferences are not sensitive data.
 *
 * @throws AccessDeniedError, with no scope, for a person who is unknown, deleted, in another
 * organisation or with an account, and for a caller without the permission: all look the
 * same.
 */
export async function readPersonPreferences(
  tx: Tx,
  ctx: PreferencesContext,
  personId: string,
): Promise<PersonPreferencesView> {
  const found = await requireStaffOn(tx, ctx, personId);
  if (found.userId !== null)
    throw new AccessDeniedError(PEOPLE_EDIT_PERMISSION);
  return {
    ...viewOf(storedPreferences(found.preferences)),
    version: found.version,
  };
}

/**
 * Sets the preferences staff keep for a person who has no account, replacing what was
 * recorded. The input is checked against the schema, and the value is written through the
 * write helper like the rest of `person`, so the change is logged as a change of the
 * person (these are not sensitive data). A save that says what is recorded writes nothing.
 * Needs `people:edit` in the person's organisation. `expectedVersion` is the version of the
 * person the caller read (`PersonPreferencesView.version`); left out, the version just read
 * is used.
 *
 * @throws AccessDeniedError, with no scope, for a person who is unknown, deleted or in
 * another organisation, and for a caller without the permission: all look the same.
 * @throws UseAccountPreferencesError when the person has an account; checked after the
 * permission, so someone who may not edit learns nothing about the person.
 * @throws PreferencesInvalidError for input that breaks the schema.
 * @throws VersionConflictError for a stale `expectedVersion`.
 * @throws RecordWriteError when the database refuses the write.
 */
export async function savePersonPreferences(
  tx: Tx,
  ctx: PreferencesContext,
  personId: string,
  input: unknown,
  options: { readonly expectedVersion?: number } = {},
): Promise<PersonPreferencesView> {
  const found = await requireStaffOn(tx, ctx, personId);
  if (found.userId !== null) throw new UseAccountPreferencesError();
  const parsed = parsePreferences(input);
  const updated = await updateRecord(
    tx,
    person,
    found.id,
    options.expectedVersion ?? found.version,
    { communicationPreferences: parsed },
    writeContext(ctx),
  );
  return {
    ...viewOf(storedPreferences(updated.communicationPreferences)),
    version: updated.version,
  };
}

/**
 * What applies to a person: the one call later modules make, such as the email module and the
 * call sheets, and nothing else reads the preferences. The person's own choices win, whole:
 * the account's preferences when they have an account and have saved any (an empty save
 * counts), otherwise what staff recorded on the person (so a person who gets an account
 * keeps what was recorded until they save their own, and from then on only theirs count),
 * otherwise nothing, so the defaults. Every field has a value, a choice or a default.
 *
 * An urgent message may override the quiet hours and the digest. That is a decision of the
 * email module (P-03c), made there: this returns the person's choices as they are and never
 * decides what is urgent. The quiet hours are `HH:MM` in the person's own time zone, and
 * may cross midnight.
 *
 * It checks no permission: it is for system code, which decides what to do with the answer.
 * It reads without a lock. The account of a deleted user is ignored. A stored value that no
 * longer fits the schema counts as nothing chosen.
 *
 * @throws RecordNotFoundError for a person who is unknown or deleted, a bug in the caller.
 */
export async function effectivePreferences(
  tx: Tx,
  personId: string,
): Promise<EffectivePreferences> {
  if (!isUuid(personId)) throw new RecordNotFoundError('person', personId);
  const [found] = await tx
    .select({
      userId: person.userId,
      preferences: person.communicationPreferences,
    })
    .from(person)
    .where(and(eq(person.id, personId), isNull(person.deletedAt)))
    .limit(1);
  if (found === undefined) throw new RecordNotFoundError('person', personId);
  let chosen: unknown = found.preferences;
  if (found.userId !== null) {
    const [account] = await tx
      .select({ payload: userPreferences.payload })
      .from(userPreferences)
      .innerJoin(user, eq(user.id, userPreferences.userId))
      .where(
        and(
          eq(userPreferences.userId, found.userId),
          isNull(userPreferences.deletedAt),
          isNull(user.deletedAt),
        ),
      )
      .limit(1);
    if (account !== undefined && chosen === null) chosen = account.payload;
  }
  return withDefaults(storedPreferences(chosen));
}

/**
 * Erases an account's preferences, because the account is going (decision D-69, P-02l2):
 * the row and its payload, with one `preferences.erased` event, actor `system`, that names
 * the user and holds nothing else. Answers whether there was a row; an account that chose
 * nothing has none, and writes no event. It takes the row `FOR UPDATE`, so a save that
 * holds it finishes first. It checks no permission and takes no lock on the user: the caller
 * is the account-deletion service, through `endAccountAccessSharing`, and holds the user row
 * `FOR UPDATE` itself, which also keeps a new save out (`saveOwnPreferences` holds that row
 * `FOR KEY SHARE`). It runs in the caller's transaction and in a savepoint of its own.
 * `now` is the time of the event; leave it out for the current time.
 *
 * @throws RangeError when `userId` is not an id (a bug in the caller); nothing was written.
 * @throws RecordWriteError when the database refuses the delete.
 */
export async function eraseUserPreferences(
  tx: Tx,
  userId: string,
  options: { readonly now?: Date } = {},
): Promise<boolean> {
  if (!isUuid(userId)) {
    throw new RangeError('An account’s preferences are erased for a user id');
  }
  const now = options.now ?? new Date();
  return guardedPreferences('user_preferences', 'delete', () =>
    tx.transaction(async (inner) => {
      const existing = await lockRow(inner, userId);
      if (existing === undefined) return false;
      await inner
        .delete(userPreferences)
        .where(eq(userPreferences.id, existing.id));
      await recordAudit(inner, {
        actor: { type: 'system', id: null },
        category: PREFERENCES_AUDIT.erased,
        action: 'erase',
        targetType: 'user',
        targetId: userId,
        occurredAt: now,
      });
      return true;
    }),
  );
}
