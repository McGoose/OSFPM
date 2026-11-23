import { recordAudit, type Tx } from '../db/write.js';
import { deleteProfileRow } from './access-profile.js';
import { ACCESS_AUDIT } from './audit.js';
import { revokeAccountGrants } from './grant-revocation.js';
import { guardedSensitive, isUuid } from './guard.js';

/**
 * Why an account's access sharing ends, from a closed list: the only code written to the
 * audit trail, so no free text can reach it. Today an account's sharing ends in one way, when
 * the account is deleted.
 */
export const ACCOUNT_SHARING_END_REASONS = ['account-deleted'] as const;
/** One value of `ACCOUNT_SHARING_END_REASONS`. */
export type AccountSharingEndReason =
  (typeof ACCOUNT_SHARING_END_REASONS)[number];

/** What `endAccountAccessSharing` ended: counts and a flag, never a name or a value. */
export type AccountSharingEnded = {
  /** The live accessibility grants it revoked, in every project of every organisation. */
  readonly accessibilityGrants: number;
  /** The live medical grants it revoked, likewise. */
  readonly medicalGrants: number;
  /** Whether the account had an access profile, which it erased. */
  readonly profileErased: boolean;
};

/**
 * Ends everything an account has shared, and erases what it stored for sharing, because the
 * account is going (decision D-69, carry-over A of P-02l2). It revokes every live
 * `accessibility` and `medical` grant of every person the account is, in every project of
 * every organisation, and erases the access profile, row and payload, as the person deleting
 * the profile does. Only the audit event stays, and it holds counts and the reason, never a
 * field name, a value or a role. The organisation's own medical record
 * (`person_sensitive`) is not touched: the grants that opened it end, the record is the
 * organisation's. A grant is revoked, never deleted, with the account holder as the one who
 * ended it (`revoked_by` cannot be empty), because it is the end of their own account's
 * sharing and nobody on staff revoked it.
 *
 * Restoring the account afterwards reopens nothing: there is no profile, and no grant is
 * live, so the person has to make a profile and grant again, which they never agreed to
 * before. Without this call a deleted account's grants stay live (they open nothing while
 * the account is deleted, because a deleted account's profile is not found) and its profile
 * and grants would open again the moment the account were restored.
 *
 * It checks no permission and takes the account as the system: the caller is the
 * account-deletion service and has decided who may delete an account. It runs in the
 * caller's transaction (in a savepoint of its own, so a refusal leaves nothing half done)
 * and takes the profile row `FOR UPDATE` before it revokes anything, so a share with the
 * usual roles that has read the profile finishes first and a later one finds no profile
 * (CLAUDE.md, Data rules). It works on an account already marked deleted. It writes one
 * `access.account-sharing-ended` event, actor `system`, even when there was nothing to end,
 * and one event for the lot and none for each grant. `now` is the time of the revocations
 * and the event; leave it out for the current time, and pass the time the caller uses for
 * the rest of the deletion so that they all agree.
 *
 * TODO(account deletion): the account-deletion service does not exist yet, so nothing calls
 * this. Accounts are soft-deleted only, and the only code that does it is a test helper.
 * When that service is written, it must call this in the transaction that marks the account
 * deleted, under the user row taken `FOR UPDATE` (`lockUser` with `strength: 'update'`, as
 * every service that ends a user's sessions does; CLAUDE.md, Data rules). Mind the lock
 * order when it does: this takes the profile row after the user row, and a share
 * holds the profile row `FOR SHARE` and then waits for the user row's key-share lock that
 * the grant it inserts takes, so the two can deadlock. PostgreSQL ends one of them
 * (SQLSTATE 40P01) and nothing is stranded, but the deletion's design must say who goes
 * first.
 *
 * @throws RangeError when `reason` is not on the closed list or `userId` is not an id (a
 * bug in the caller); nothing was written.
 * @throws RecordWriteError when the database refuses a write; it carries the SQLSTATE and
 * constraint name only, and nothing was ended.
 */
export async function endAccountAccessSharing(
  tx: Tx,
  userId: string,
  reason: AccountSharingEndReason,
  options: { readonly now?: Date } = {},
): Promise<AccountSharingEnded> {
  if (!(ACCOUNT_SHARING_END_REASONS as readonly string[]).includes(reason)) {
    throw new RangeError('Unknown reason for ending an account’s sharing');
  }
  if (!isUuid(userId)) {
    throw new RangeError('An account’s sharing ends for a user id');
  }
  const now = options.now ?? new Date();
  return guardedSensitive('user_access_profile', 'delete', () =>
    tx.transaction(async (inner) => {
      // The profile first, `FOR UPDATE`: a share that has read it holds it `FOR SHARE` and
      // writes grants derived from it, so it finishes before the grants are revoked below,
      // and one that starts later finds no profile and writes nothing.
      const profileErased = await deleteProfileRow(inner, userId);
      const revoked = await revokeAccountGrants(
        inner,
        userId,
        ['accessibility', 'medical'],
        userId,
        now,
      );
      await recordAudit(inner, {
        actor: { type: 'system', id: null },
        category: ACCESS_AUDIT.accountSharingEnded,
        action: 'end',
        targetType: 'user',
        targetId: userId,
        details: {
          reason,
          accessibilityGrants: revoked.accessibility,
          medicalGrants: revoked.medical,
          profileErased,
        },
        occurredAt: now,
      });
      return {
        accessibilityGrants: revoked.accessibility,
        medicalGrants: revoked.medical,
        profileErased,
      };
    }),
  );
}
