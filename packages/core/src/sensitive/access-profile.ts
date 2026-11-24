import { and, eq, isNull, sql } from 'drizzle-orm';
import { user, userAccessProfile } from '../db/schema/index.js';
import { recordAudit, RecordNotFoundError, type Tx } from '../db/write.js';
import { holdAccount } from './account-lock.js';
import { ACCESS_AUDIT, auditActor, tokenMark } from './audit.js';
import {
  AccessProfileExistsError,
  AccountDeletedError,
  SensitiveAccessDeniedError,
  type SensitiveOperation,
} from './errors.js';
import { revokeAccountGrants } from './grant-revocation.js';
import { driverErrorOf, guardedSensitive, isUuid } from './guard.js';
import { parsePayload, samePayload } from './payload.js';
import type { SensitivePayload } from './schemas.js';
import type { SensitiveContext } from './service.js';

/**
 * A person's access profile (decision D-69): the structured adjustments they ask for,
 * kept on their account and owned by them. Only the person themselves creates, reads,
 * changes or deletes it, through these four functions (when their account is deleted,
 * `endAccountAccessSharing` erases it for them); nobody else can reach it, not an
 * organisation owner and not an administrator. What a production sees of it is only what
 * the person has granted to a role of that project (`createAccessGrant`), and the profile
 * itself stays when a project wraps.
 *
 * The three that write take the account's user row `FOR KEY SHARE` first (`holdAccount`) and
 * the profile row after it, the order of the lock rules (CLAUDE.md, Data rules). Deleting the
 * account takes the user row `FOR UPDATE` and then the profile row, so a write that took the
 * profile first and reached the user row later, through the foreign key of a row it inserts or
 * of a grant it revokes, could wait for the deletion while the deletion waited for it. Both
 * go user row first, so they queue. A profile is made only for an account that is live
 * (`AccountDeletedError`), or a creation that came after the account's erasure would leave a
 * profile behind; deleting or changing one does not look at the account, because a deleted
 * account may always end what it shared.
 *
 * Every allowed read writes one `sensitive.read` event and every denial one
 * `sensitive.denied` event, and a change writes `access.profile-created`,
 * `access.profile-updated` or `access.profile-deleted`: the events name the user and
 * count the fields of a read or the grants a deletion ended, and hold no field name and
 * no value. Changes are audited and not change-logged, because the table has no
 * organisation to number them in (CLAUDE.md, Data rules). Nothing here logs.
 */

/** A person's access profile, as its owner reads it. */
export type AccessProfile = {
  readonly id: string;
  readonly userId: string;
  readonly version: number;
  readonly payload: SensitivePayload<'accessibility'>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

type ProfileRow = typeof userAccessProfile.$inferSelect;

function toProfile(row: ProfileRow): AccessProfile {
  return {
    id: row.id,
    userId: row.userId,
    version: row.version,
    payload: row.payload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The profile of a user, or `undefined`: none was made, or the account was deleted, which
 * takes the profile with it. Checks no permission: it is the door's own helper, for code
 * that has already decided who may ask. It reads without a lock, unless `lock` is
 * `'share'`: then the profile row is held `FOR SHARE` until the transaction ends, and
 * nothing else is locked (not the user row, which a caller that writes takes first, with
 * `holdAccount`), so a deletion of the profile, which takes the row `FOR UPDATE`, waits for
 * a caller that is about to write something derived from what it reads. When the profile is
 * deleted while this waits, it answers `undefined`.
 */
export async function loadProfile(
  tx: Tx,
  userId: string,
  options: { readonly lock?: 'share' } = {},
): Promise<ProfileRow | undefined> {
  if (!isUuid(userId)) return undefined;
  const query = tx
    .select({ profile: userAccessProfile })
    .from(userAccessProfile)
    .innerJoin(user, eq(user.id, userAccessProfile.userId))
    .where(
      and(
        eq(userAccessProfile.userId, userId),
        isNull(userAccessProfile.deletedAt),
        isNull(user.deletedAt),
      ),
    )
    .limit(1);
  const [found] =
    options.lock === 'share'
      ? await query.for('share', { of: userAccessProfile })
      : await query;
  return found?.profile;
}

/** The profile row `FOR UPDATE`, without the user row: a write holds the profile and nothing else. */
async function lockProfileRow(
  tx: Tx,
  userId: string,
): Promise<ProfileRow | undefined> {
  const [row] = await tx
    .select()
    .from(userAccessProfile)
    .where(
      and(
        eq(userAccessProfile.userId, userId),
        isNull(userAccessProfile.deletedAt),
      ),
    )
    .limit(1)
    .for('update');
  return row;
}

/**
 * Lets only the owner through. A personal API token never takes the person's own way in
 * (decision D-68): the owner of the account reads their own profile by signing in. A
 * denial is audited and thrown, and is the same for every other user and for an id that
 * is not a user, so ids cannot be probed.
 */
async function authoriseOwner(
  tx: Tx,
  ctx: SensitiveContext,
  userId: string,
  operation: SensitiveOperation,
): Promise<void> {
  if (ctx.userId === userId && ctx.credential?.kind !== 'token') return;
  await recordAudit(tx, {
    actor: auditActor(ctx),
    category: 'sensitive.denied',
    action: operation,
    targetType: 'user',
    targetId: isUuid(userId) ? userId : null,
    details: { category: 'accessibility', ...tokenMark(ctx) },
    requestId: ctx.requestId ?? null,
    occurredAt: ctx.clock(),
  });
  throw new SensitiveAccessDeniedError('accessibility', operation);
}

/**
 * One audit event for a change to the profile: the user, a count when the change has one
 * (never a name or a value), and the token that did it.
 */
function auditChange(
  tx: Tx,
  ctx: SensitiveContext,
  category: string,
  action: string,
  userId: string,
  now: Date,
  counts: Readonly<Record<string, number>> = {},
) {
  const details = { ...counts, ...tokenMark(ctx) };
  return recordAudit(tx, {
    actor: auditActor(ctx),
    category,
    action,
    targetType: 'user',
    targetId: userId,
    details: Object.keys(details).length === 0 ? null : details,
    requestId: ctx.requestId ?? null,
    occurredAt: now,
  });
}

/**
 * Audits the refusal of a profile for an account that is deleted, as `access.refused` with
 * the reason code and the category, as the refusals of the grant model are, and throws it.
 * The event is written before the error is thrown, so a caller catches the error inside its
 * transaction and commits (CLAUDE.md, Data rules). It names the user and holds no value.
 */
async function refuseDeletedAccount(
  tx: Tx,
  ctx: SensitiveContext,
  userId: string,
  now: Date,
): Promise<never> {
  await recordAudit(tx, {
    actor: auditActor(ctx),
    category: ACCESS_AUDIT.refused,
    action: 'account-deleted',
    targetType: 'user',
    targetId: isUuid(userId) ? userId : null,
    details: { reason: 'account-deleted', category: 'accessibility' },
    requestId: ctx.requestId ?? null,
    occurredAt: now,
  });
  throw new AccountDeletedError();
}

/**
 * Makes the signed-in person's access profile. The payload is checked against the
 * `accessibility` schema before anything is written. Audited as
 * `access.profile-created`, with the user and nothing else. It holds the account's user row
 * `FOR KEY SHARE` before it takes anything else, and refuses an account that is deleted: the
 * deletion of the account erases the profile, so one made after it would be left behind.
 *
 * @throws SensitiveAccessDeniedError (after auditing it) for anyone but the person, and
 * for a personal API token.
 * @throws SensitivePayloadInvalidError for a payload that breaks the schema; it lists
 * paths and codes, never values.
 * @throws AccountDeletedError (after auditing the refusal) when the account is deleted.
 * @throws AccessProfileExistsError when the person already has a profile.
 * @throws RecordWriteError when the database refuses the row; it carries the SQLSTATE and
 * constraint name only.
 */
export async function createAccessProfile(
  tx: Tx,
  ctx: SensitiveContext,
  userId: string,
  payload: unknown,
): Promise<AccessProfile> {
  await authoriseOwner(tx, ctx, userId, 'write');
  const parsed = parsePayload('accessibility', payload);
  const now = ctx.clock();
  // The user row first (CLAUDE.md, Data rules: lock order), outside the savepoint, so the
  // hold lasts until the caller's transaction ends whatever the savepoint does.
  if (!(await holdAccount(tx, userId))) {
    await refuseDeletedAccount(tx, ctx, userId, now);
  }
  return guardedSensitive('user_access_profile', 'insert', () =>
    // A savepoint: a refusal leaves no row and no event.
    tx.transaction(async (inner) => {
      if ((await lockProfileRow(inner, userId)) !== undefined) {
        throw new AccessProfileExistsError();
      }
      let row: ProfileRow | undefined;
      try {
        [row] = await inner
          .insert(userAccessProfile)
          .values({
            originServer: ctx.originServer,
            userId,
            payload: parsed as Record<string, unknown>,
            createdAt: now,
            updatedAt: now,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          })
          .returning();
      } catch (error) {
        // Two creates at once: the other one got there first.
        if (driverErrorOf(error)?.code === '23505') {
          throw new AccessProfileExistsError();
        }
        throw error;
      }
      await auditChange(
        inner,
        ctx,
        ACCESS_AUDIT.profileCreated,
        'create',
        userId,
        now,
      );
      return toProfile(row!);
    }),
  );
}

/**
 * Reads the signed-in person's access profile, or `null` when they have none. Writes one
 * `sensitive.read` event, whether or not there is a profile, with the number of fields
 * returned and never their names. The stored payload was checked when it was written and
 * is returned as stored.
 *
 * @throws SensitiveAccessDeniedError (after auditing it) for anyone but the person, and
 * for a personal API token.
 */
export async function readAccessProfile(
  tx: Tx,
  ctx: SensitiveContext,
  userId: string,
): Promise<AccessProfile | null> {
  await authoriseOwner(tx, ctx, userId, 'read');
  const row = await loadProfile(tx, userId);
  await recordAudit(tx, {
    actor: auditActor(ctx),
    category: 'sensitive.read',
    action: 'read',
    targetType: 'user',
    targetId: userId,
    details: {
      category: 'accessibility',
      fieldCount: row === undefined ? 0 : Object.keys(row.payload).length,
      ...tokenMark(ctx),
    },
    requestId: ctx.requestId ?? null,
    occurredAt: ctx.clock(),
  });
  return row === undefined ? null : toProfile(row);
}

/**
 * Replaces the signed-in person's access profile with the payload, which is checked first.
 * A payload that says what is stored writes nothing and audits nothing: there is nothing
 * to announce. Otherwise the version goes up and one `access.profile-updated` event names
 * the user. It holds the account's user row `FOR KEY SHARE` before it takes the profile row,
 * and does not look at whether the account is deleted: the deletion of an account erases its
 * profile, so a deleted account has none to change.
 *
 * @throws SensitiveAccessDeniedError (after auditing it) for anyone but the person, and
 * for a personal API token.
 * @throws SensitivePayloadInvalidError for a payload that breaks the schema.
 * @throws RecordNotFoundError when the person has no profile to update.
 * @throws RecordWriteError when the database refuses the write.
 */
export async function updateAccessProfile(
  tx: Tx,
  ctx: SensitiveContext,
  userId: string,
  payload: unknown,
): Promise<AccessProfile> {
  await authoriseOwner(tx, ctx, userId, 'write');
  const parsed = parsePayload('accessibility', payload);
  const now = ctx.clock();
  // The user row first (CLAUDE.md, Data rules: lock order). What it says about the account
  // does not matter here: there is only a profile to change if the deletion left one.
  await holdAccount(tx, userId);
  return guardedSensitive('user_access_profile', 'update', () =>
    tx.transaction(async (inner) => {
      const existing = await lockProfileRow(inner, userId);
      if (existing === undefined) {
        throw new RecordNotFoundError('user_access_profile', userId);
      }
      if (samePayload(existing.payload, parsed)) return toProfile(existing);
      const [row] = await inner
        .update(userAccessProfile)
        .set({
          payload: parsed,
          version: sql`${userAccessProfile.version} + 1`,
          updatedAt: now,
          updatedBy: ctx.userId,
        })
        .where(eq(userAccessProfile.id, existing.id))
        .returning();
      await auditChange(
        inner,
        ctx,
        ACCESS_AUDIT.profileUpdated,
        'update',
        userId,
        now,
      );
      return toProfile(row!);
    }),
  );
}

/**
 * Ends every live accessibility grant of every person the account is, in every project
 * of every organisation, and answers how many it ended. A grant only chooses who sees
 * which fields of the profile, so one that outlived the profile would open the next
 * profile the person makes, which they never agreed to (decision D-69). Medical grants
 * are not touched: they open the organisation's record, not the profile. It writes no
 * event of its own: the caller writes one for the lot. It reads and checks no permission,
 * and runs in the caller's transaction (`revokeAccountGrants` does the work).
 */
async function revokeAccessibilityGrants(
  tx: Tx,
  ctx: SensitiveContext,
  userId: string,
  now: Date,
): Promise<number> {
  const ended = await revokeAccountGrants(
    tx,
    userId,
    ['accessibility'],
    ctx.userId,
    now,
  );
  return ended.accessibility;
}

/**
 * Deletes the access profile of an account, for good, and answers whether there was one.
 * It takes the profile row `FOR UPDATE`, so a share with the usual roles that has read the
 * profile (and holds it `FOR SHARE` until it commits) finishes before the row goes and a
 * share that comes later finds none. It does not look at the account's state, so it works on
 * an account already marked deleted, which `loadProfile` does not. It checks no permission
 * and writes no event: the callers, the owner's `deleteAccessProfile` and the door's
 * `endAccountAccessSharing`, have decided who may and write the event, and they end the
 * grants that opened the profile in the same transaction. They hold the account's user row
 * first: the owner's call `FOR KEY SHARE` (`holdAccount`), and the account-deletion service
 * that will call the door `FOR UPDATE` (the TODO of `endAccountAccessSharing`), so the profile
 * row is never the first row lock taken for a deletion of the profile.
 */
export async function deleteProfileRow(
  tx: Tx,
  userId: string,
): Promise<boolean> {
  const existing = await lockProfileRow(tx, userId);
  if (existing === undefined) return false;
  await tx
    .delete(userAccessProfile)
    .where(eq(userAccessProfile.id, existing.id));
  return true;
}

/**
 * Deletes the signed-in person's access profile, for good: the row and its payload go,
 * and so does everything that opened it. Every live accessibility grant of the person, in
 * every project of every organisation, is revoked in the same transaction, so a profile
 * made later opens nothing until the person grants again; their medical grants are not
 * touched. One `access.profile-deleted` event names the user and holds the number of
 * grants it revoked (`revokedGrants`, which is 0 when there were none), and no event is
 * written for each grant. It holds the account's user row `FOR KEY SHARE` before it takes the
 * profile row: the grants it revokes name the person as the one who revoked them, which takes
 * the same row's key-share lock, so with the profile first it could wait for a deletion of
 * the account that waits for the profile. An account that is deleted may still do this: ending
 * what it shared is always allowed.
 *
 * @throws SensitiveAccessDeniedError (after auditing it) for anyone but the person, and
 * for a personal API token.
 * @throws RecordNotFoundError when the person has no profile.
 * @throws RecordWriteError when the database refuses the delete or a revoke; nothing is
 * deleted or revoked.
 */
export async function deleteAccessProfile(
  tx: Tx,
  ctx: SensitiveContext,
  userId: string,
): Promise<void> {
  await authoriseOwner(tx, ctx, userId, 'delete');
  const now = ctx.clock();
  // The user row first (CLAUDE.md, Data rules: lock order). The answer does not matter: a
  // deleted account may end what it shared.
  await guardedSensitive('user_access_profile', 'delete', () =>
    tx.transaction(async (inner) => {
      if (!(await deleteProfileRow(inner, userId))) {
        throw new RecordNotFoundError('user_access_profile', userId);
      }
      const revokedGrants = await revokeAccessibilityGrants(
        inner,
        ctx,
        userId,
        now,
      );
      await auditChange(
        inner,
        ctx,
        ACCESS_AUDIT.profileDeleted,
        'delete',
        userId,
        now,
        { revokedGrants },
      );
    }),
  );
}
