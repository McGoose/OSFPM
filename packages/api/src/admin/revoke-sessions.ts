import {
  readInstallationId,
  recordAdminCommandRun,
} from '@osfpm/core/src/auth/admin-report.js';
import {
  listUsersWithLiveAccess,
  revokeSessionsOfPerson,
  type SessionRevocation,
} from '@osfpm/core/src/auth/admin-sessions.js';
import type { RevokeSessionsRequest } from './args.js';
import {
  AdminRefusal,
  type AdminContext,
  type AdminSession,
} from './session.js';

/**
 * The `revoke-sessions` command (P-09a2, decision D-81): end every live session of
 * one person or of everyone, and with `--include-api-tokens` their personal API
 * tokens too, for an operator who suspects an account or a whole installation is
 * compromised. What it changes is the core's (`revokeSessionsOfPerson`); this file
 * asks, in the right shape, and prints counts and user ids and nothing else.
 *
 * One person is one transaction, and `--all` is one transaction for each person who
 * has anything live, never one statement across people, so no transaction ever holds
 * more than one user row (CLAUDE.md, Data rules: lock order). A session made while
 * `--all` runs may survive it; stop the servers first for a hard cut-off. The command
 * only writes rows a server writes too, so on PostgreSQL it runs beside a running
 * server.
 */

/** `1 session`, `2 sessions`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** What was ended, as the words after a colon or `Revoked`: sessions, and tokens when they were asked for. */
function endedText(
  sessions: number,
  tokens: number,
  includeApiTokens: boolean,
): string {
  return includeApiTokens
    ? `${count(sessions, 'session')} and ${count(tokens, 'API token')}`
    : count(sessions, 'session');
}

/**
 * Runs `revoke-sessions`: ends what is live for the person named, or for everyone with
 * `--all`, prints one line for each person, with their user id and the counts, and a
 * total, and writes one `admin.command-run` event with the totals (the events for each
 * person, `auth.sessions-revoked` for sessions and `auth.api-tokens-revoked` for
 * tokens, each only when it ended something, are the core's: the command writes more
 * than one event). Exit code 0.
 *
 * For one person it always prints their line, even when they had nothing live; for
 * `--all` it prints only the people who had something. A person who is deleted while
 * `--all` runs, or never was, is skipped.
 *
 * @throws AdminRefusal, with one fixed sentence that names no one, when no live
 * account matches the address or id given. The refusal was audited as an
 * `admin.command-run` event with the outcome `refused`.
 */
export async function runRevokeSessions(
  request: RevokeSessionsRequest,
  session: AdminSession,
  context: AdminContext,
): Promise<number> {
  const clock = context.now ?? (() => new Date());
  const { db } = session.database;
  const { includeApiTokens, target } = request;
  const done: SessionRevocation[] = [];

  if (target.kind === 'all') {
    const ids = await db.transaction((tx) =>
      listUsersWithLiveAccess(tx, { includeApiTokens, now: clock() }),
    );
    for (const userId of ids) {
      const revoked = await db.transaction((tx) =>
        revokeSessionsOfPerson(
          tx,
          { kind: 'user', userId },
          { includeApiTokens, now: clock() },
        ),
      );
      if (revoked !== null && (revoked.sessions > 0 || revoked.tokens > 0)) {
        done.push(revoked);
      }
    }
  } else {
    const revoked = await db.transaction((tx) =>
      revokeSessionsOfPerson(tx, target, { includeApiTokens, now: clock() }),
    );
    if (revoked === null) {
      await db.transaction(async (tx) =>
        recordAdminCommandRun(tx, {
          command: 'revoke-sessions',
          outcome: 'refused',
          installationId: await readInstallationId(tx),
          details: { reason: 'unknown-user' },
          now: clock(),
        }),
      );
      throw new AdminRefusal('No account matches.');
    }
    done.push(revoked);
  }

  const sessions = done.reduce((total, found) => total + found.sessions, 0);
  const tokens = done.reduce((total, found) => total + found.tokens, 0);
  await db.transaction(async (tx) =>
    recordAdminCommandRun(tx, {
      command: 'revoke-sessions',
      outcome: 'completed',
      installationId: await readInstallationId(tx),
      details: {
        users: done.length,
        sessionsRevoked: sessions,
        tokensRevoked: tokens,
        all: target.kind === 'all',
        includeApiTokens,
      },
      now: clock(),
    }),
  );

  const lines = done.map(
    (found) =>
      `${found.userId}: ${endedText(found.sessions, found.tokens, includeApiTokens)} revoked`,
  );
  lines.push(
    `Revoked ${endedText(sessions, tokens, includeApiTokens)} of ${count(done.length, 'user')}.`,
  );
  context.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
