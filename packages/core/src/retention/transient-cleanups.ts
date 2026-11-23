import { cleanupAccessResets } from '../auth/access-reset-cleanup.js';
import { cleanupInvites } from '../auth/invite-cleanup.js';
import { cleanupExpiredChallenges } from '../auth/login-challenge.js';
import { cleanupEndedSessions } from '../auth/sessions.js';
import { cleanupSetupCodes } from '../auth/setup-code.js';
import type { Tx } from '../db/write.js';

/**
 * The cleanup of one `transient` table: deletes the rows that are of no use at
 * `now` and returns how many it deleted. It writes no audit event and checks no
 * permission: only the worker calls it, with the transaction handle and the
 * time. It throws `RecordWriteError` when the database refuses the delete.
 */
export type TransientCleanup = (tx: Tx, now: Date) => Promise<number>;

/**
 * The cleanup of every table whose default retention class is `transient`, by
 * table name. The worker calls each on a schedule, with the same `now`. The
 * class has no period, so retention never purges these rows; without a cleanup
 * here they would stay for ever and nothing would say so. So
 * `transient-cleanups.test.ts` fails, finding the transient tables from the
 * schema, when a transient table has no entry, and when an entry names a table
 * that is not transient (maintainer decision, P-03b3a).
 */
export const TRANSIENT_CLEANUPS: ReadonlyMap<string, TransientCleanup> =
  new Map([
    ['access_reset', cleanupAccessResets],
    // Its role links (invite_role) go with it, by ON DELETE CASCADE.
    ['invite', cleanupInvites],
    ['login_challenge', cleanupExpiredChallenges],
    ['session', cleanupEndedSessions],
    ['setup_code', cleanupSetupCodes],
  ]);
