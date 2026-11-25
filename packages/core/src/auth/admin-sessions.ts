import type { Tx } from '../db/write.js';
import { findAdminPerson, type AdminPerson } from './admin-report.js';
import {
  listUsersWithLiveApiTokens,
  revokeApiTokensOfUser,
} from './api-tokens.js';
import { AuthStateError } from './errors.js';
import { listUsersWithLiveSessions, revokeUserSessions } from './sessions.js';
import {
  AUTH_AUDIT,
  guardedAuth,
  lockUser,
  recordAuthAudit,
} from './shared.js';

/**
 * What the admin command `revoke-sessions` asks of the core (P-09a2, decision D-81):
 * end every live session of one person, or of everyone, from the command line, for
 * an operator who has shell access to the server (decision D-64) and no signed-in
 * person to act as. Each person gets up to two events, both from the system, with the
 * reason `admin-action` and a count: `auth.sessions-revoked`, which the sessions' own
 * service writes, and `auth.api-tokens-revoked`, which this one writes for the tokens;
 * each only when it ended something. The command adds one `admin.command-run` with
 * the totals.
 *
 * It only ends access. It never signs anyone in, changes a password or a passkey, or
 * touches the person's account.
 */

/** What the revocation is told. */
export type SessionRevocationOptions = {
  /**
   * Whether the person's live personal API tokens end too (reason `admin-action`),
   * as well as their sessions. A token is a script's own way in, and outlives every
   * session, so ending sessions alone does not cut a person off.
   */
  readonly includeApiTokens: boolean;
  /** The time of the change, for the rows and the events. */
  readonly now: Date;
};

/** What was ended for one person. */
export type SessionRevocation = {
  readonly userId: string;
  /** The sessions that were live and are now revoked. */
  readonly sessions: number;
  /** The personal API tokens that were live and are now revoked; 0 unless asked for. */
  readonly tokens: number;
};

/**
 * Ends every live session of one person, and with `includeApiTokens` every live
 * personal API token of theirs too, and answers what it ended, or `null` when no live
 * account matches (an address no one has, an id no one has, a deleted account). A
 * disabled or invited account is found: it may still have sessions or tokens to end.
 *
 * It takes the person's user row `FOR UPDATE` first, before it judges or changes
 * anything else, as every service that ends a person's sessions in bulk does
 * (CLAUDE.md, Data rules: lock order). Only `FOR UPDATE` conflicts with the
 * key-share lock `createApiToken` holds while it checks the session it is made from,
 * so a token is never made from a session this call ended, and a token being made is
 * either revoked here or refused. The sessions are revoked by `revokeUserSessions`,
 * which writes one `auth.sessions-revoked` event, from the system, only when it ended
 * any; the tokens are revoked by `revokeApiTokensOfUser`, in id order, which writes no
 * event of its own, so this writes one `auth.api-tokens-revoked`, from the system,
 * with the reason and the count and nothing that names a token, only when it ended
 * any. Nothing is written for a person who has nothing live.
 *
 * Checks no permission: the caller is the operator's command line. Run it once for
 * each person, each in its own transaction: it never takes more than one user row,
 * so a run across everyone is as many small transactions as there are people.
 *
 * @throws RecordWriteError when the database refuses a read or a write; it carries
 * the SQLSTATE and constraint name only, never an address.
 */
export function revokeSessionsOfPerson(
  tx: Tx,
  person: AdminPerson,
  options: SessionRevocationOptions,
): Promise<SessionRevocation | null> {
  return guardedAuth('session', 'update', async () => {
    const found = await findAdminPerson(tx, person);
    if (found === undefined) return null;
    try {
      await lockUser(tx, found.id, { strength: 'update' });
    } catch (error) {
      // Deleted since the first look.
      if (error instanceof AuthStateError) return null;
      throw error;
    }
    const sessions = await revokeUserSessions(tx, found.id, {
      reason: 'admin-action',
      actor: { type: 'system', id: null },
      now: options.now,
    });
    const tokens = options.includeApiTokens
      ? await revokeApiTokensOfUser(tx, found.id, 'admin-action', options.now)
      : 0;
    if (tokens > 0) {
      // Like the sessions' event, and for the same reason: a person's access ended,
      // and the trail says whose, when and why, in the same transaction as the change.
      await recordAuthAudit(tx, {
        category: AUTH_AUDIT.apiTokensRevoked,
        action: 'revoke-all',
        actor: { type: 'system', id: null },
        targetType: 'user',
        targetId: found.id,
        details: { reason: 'admin-action', count: tokens },
        occurredAt: options.now,
      });
    }
    return { userId: found.id, sessions, tokens };
  });
}

/**
 * The ids of the people whose access `revoke-sessions --all` has to end, in id order:
 * everyone with an account that is not deleted who has a session that is live at
 * `now`, and, with `includeApiTokens`, everyone who has a live personal API token. A
 * deleted account cannot sign in, so its sessions and tokens already work for no one.
 * Reads without a lock: each person is then revoked in a transaction of their own
 * (`revokeSessionsOfPerson`), so a person who signs in after this list was made is
 * not on it, and a session made during a run may survive it. Stop the servers first
 * for a hard cut-off.
 *
 * @throws RecordWriteError when the database refuses a read; it carries the SQLSTATE
 * only.
 */
export async function listUsersWithLiveAccess(
  tx: Tx,
  options: SessionRevocationOptions,
): Promise<string[]> {
  const ids = new Set(await listUsersWithLiveSessions(tx, options.now));
  if (options.includeApiTokens) {
    for (const id of await listUsersWithLiveApiTokens(tx, options.now)) {
      ids.add(id);
    }
  }
  return [...ids].sort();
}
