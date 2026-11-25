import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '@osfpm/core/src/access/test-fixtures.js';
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import {
  emailOf,
  markUserDeleted,
  seedApiToken,
  seedMembership,
  seedResetScene,
  seedSession,
  type ResetScene,
} from '@osfpm/core/src/auth/test-support.js';
import type { Database } from '@osfpm/core/src/db/client.js';
import {
  apiToken,
  auditEvent,
  session,
} from '@osfpm/core/src/db/schema/index.js';
import {
  createMigratedDatabase,
  testTargets,
} from '@osfpm/core/src/db/test-support.js';
import {
  createTestKeyDirectory,
  type TestKeyDirectory,
} from '@osfpm/core/src/keys/test-support.js';
import { adminEnvironment, runCommand } from './test-support.js';

/**
 * The `revoke-sessions` command (P-09a2, decision D-81): end every live session of
 * one person or of everyone, and with `--include-api-tokens` their personal API
 * tokens too. What it asks of the core is in `admin-sessions.test.ts`, and the lock it
 * takes on the person's row in `session-revocation-locks.test.ts`; these tests run the
 * command line over a real database and read what it printed and audited.
 */

const NOW = new Date('2026-03-12T09:00:00.000Z');

/** `1 session`, `2 sessions`. */
const sessions = (n: number) => `${n} session${n === 1 ? '' : 's'}`;
/** `1 API token`, `2 API tokens`. */
const tokens = (n: number) => `${n} API token${n === 1 ? '' : 's'}`;

describe.each(testTargets)('the revoke-sessions command on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let keyDirectory: TestKeyDirectory;
  let scene: ResetScene;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    keyDirectory = createTestKeyDirectory();
    scene = await seedResetScene(database, NOW);
  });
  afterAll(async () => {
    await cleanup();
    keyDirectory.remove();
  });

  const db = () => database.db;
  const run = (...argv: string[]) =>
    runCommand(argv, {
      env: adminEnvironment(target.name, keyDirectory.dir),
      database,
      now: () => NOW,
    });

  /** A member of the organisation with `live` live sessions and, as tokens, `liveTokens` live ones. */
  async function person(live: number, liveTokens = 0) {
    const userId = await seedUser(database);
    await seedMembership(database, scene.organisationId, userId, 'member', []);
    const ids: string[] = [];
    for (let n = 0; n < live; n += 1) {
      ids.push(await seedSession(database, userId));
    }
    const tokenIds: string[] = [];
    for (let n = 0; n < liveTokens; n += 1) {
      tokenIds.push(
        (await seedApiToken(database, scene.organisationId, userId)).id,
      );
    }
    return { userId, ids, tokenIds };
  }

  const sessionRows = async () => db().select().from(session);
  const tokenRows = async () => db().select().from(apiToken);
  const audits = async (category: string) =>
    (await db().select().from(auditEvent))
      .filter((event) => event.category === category)
      .sort((a, b) => a.id.localeCompare(b.id));
  /** What a command left that is of no one's: the events since `before`. */
  const eventsSince = async (category: string, before: number) =>
    (await audits(category)).slice(before);

  /** Every session that is live now. */
  const liveSessions = async () =>
    (await sessionRows()).filter((found) => found.revokedAt === null);

  it('ends the live sessions of one person, found by id, and prints how many with the id and nothing else', async () => {
    const who = await person(2);
    const bystander = await person(1);

    const result = await run('revoke-sessions', '--user', who.userId);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      `${who.userId}: ${sessions(2)} revoked\nRevoked ${sessions(2)} of 1 user.\n`,
    );
    for (const found of await sessionRows()) {
      if (who.ids.includes(found.id)) {
        expect(found).toMatchObject({
          revokedAt: NOW,
          revokedReason: 'admin-action',
        });
      }
      if (bystander.ids.includes(found.id)) {
        expect(found.revokedAt).toBeNull();
      }
    }
  });

  it('finds the person by the address as typed, and prints, logs and audits no address', async () => {
    const who = await person(1);
    const email = await emailOf(database, who.userId);
    const before = (await audits(AUTH_AUDIT.sessionsRevoked)).length;

    const result = await run(
      'revoke-sessions',
      '--email',
      `  ${email.toUpperCase()}  `,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `${who.userId}: ${sessions(1)} revoked\nRevoked ${sessions(1)} of 1 user.\n`,
    );
    expect(result.stdout + result.stderr).not.toContain(email);
    const written = await eventsSince(AUTH_AUDIT.sessionsRevoked, before);
    expect(written).toHaveLength(1);
    expect(JSON.stringify(await db().select().from(auditEvent))).not.toContain(
      email,
    );
  });

  it('writes the sessions’ own event for each person, from the system, and one admin.command-run with the totals', async () => {
    const who = await person(3);
    const sessionEvents = (await audits(AUTH_AUDIT.sessionsRevoked)).length;
    const runs = (await audits(AUTH_AUDIT.adminCommandRun)).length;

    await run('revoke-sessions', '--user', who.userId);

    const events = await eventsSince(AUTH_AUDIT.sessionsRevoked, sessionEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'system',
      actorId: null,
      targetId: who.userId,
      details: { reason: 'admin-action', count: 3 },
    });
    const written = await eventsSince(AUTH_AUDIT.adminCommandRun, runs);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      action: 'run',
      actorType: 'system',
      actorId: null,
      targetType: 'installation',
      details: {
        command: 'revoke-sessions',
        outcome: 'completed',
        users: 1,
        sessionsRevoked: 3,
        tokensRevoked: 0,
        all: false,
        includeApiTokens: false,
      },
    });
  });

  it('leaves personal API tokens alone unless asked, and ends them with --include-api-tokens: the reason admin-action, no one named', async () => {
    const who = await person(2, 2);
    const tokenEvents = (await audits(AUTH_AUDIT.apiTokensRevoked)).length;
    const withoutFlag = await run('revoke-sessions', '--user', who.userId);
    expect(withoutFlag.stdout).toContain(`${sessions(2)} revoked`);
    for (const found of await tokenRows()) {
      if (who.tokenIds.includes(found.id)) {
        expect(found.revokedAt).toBeNull();
      }
    }
    // Nothing is said about tokens that were left alone.
    expect(await audits(AUTH_AUDIT.apiTokensRevoked)).toHaveLength(tokenEvents);

    // The sessions are gone already: only the tokens are left to end.
    const withFlag = await run(
      'revoke-sessions',
      '--user',
      who.userId,
      '--include-api-tokens',
    );

    expect(withFlag.code).toBe(0);
    expect(withFlag.stdout).toBe(
      `${who.userId}: ${sessions(0)} and ${tokens(2)} revoked\nRevoked ${sessions(0)} and ${tokens(2)} of 1 user.\n`,
    );
    for (const found of await tokenRows()) {
      if (who.tokenIds.includes(found.id)) {
        expect(found).toMatchObject({
          revokedAt: NOW,
          revokeReason: 'admin-action',
          revokedBy: null,
        });
      }
    }
    // One event for the tokens of this person, as the sessions have one: from the
    // system, with the reason and the count.
    const ended = await eventsSince(AUTH_AUDIT.apiTokensRevoked, tokenEvents);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      action: 'revoke-all',
      actorType: 'system',
      actorId: null,
      targetType: 'user',
      targetId: who.userId,
      details: { reason: 'admin-action', count: 2 },
    });
    const [written] = (await audits(AUTH_AUDIT.adminCommandRun)).slice(-1);
    expect(written!.details).toMatchObject({
      sessionsRevoked: 0,
      tokensRevoked: 2,
      includeApiTokens: true,
    });
  });

  it('ends the sessions and the tokens of one person in one go', async () => {
    const who = await person(1, 1);

    const result = await run(
      'revoke-sessions',
      '--user',
      who.userId,
      '--include-api-tokens',
    );

    expect(result.stdout).toBe(
      `${who.userId}: ${sessions(1)} and ${tokens(1)} revoked\nRevoked ${sessions(1)} and ${tokens(1)} of 1 user.\n`,
    );
  });

  describe('--all', () => {
    /** A database of its own, so the totals are the whole installation's. */
    async function installation() {
      const fresh = await createMigratedDatabase(target);
      const freshScene = await seedResetScene(fresh.database, NOW);
      const member = async (live: number, liveTokens = 0) => {
        const userId = await seedUser(fresh.database);
        await seedMembership(
          fresh.database,
          freshScene.organisationId,
          userId,
          'member',
          [],
        );
        for (let n = 0; n < live; n += 1) {
          await seedSession(fresh.database, userId);
        }
        for (let n = 0; n < liveTokens; n += 1) {
          await seedApiToken(fresh.database, freshScene.organisationId, userId);
        }
        return userId;
      };
      const runHere = (...argv: string[]) =>
        runCommand(argv, {
          env: adminEnvironment(target.name, keyDirectory.dir),
          database: fresh.database,
          now: () => NOW,
        });
      return { ...fresh, freshScene, member, runHere };
    }

    it('ends every live session of everyone, a person at a time in id order, and prints each person’s count and the totals', async () => {
      const here = await installation();
      try {
        const a = await here.member(2);
        const b = await here.member(1);
        const c = await here.member(3);
        const quiet = await here.member(0);
        const tokenOnly = await here.member(0, 1);
        const gone = await here.member(2);
        await markUserDeleted(here.database, gone, NOW);
        const owner = here.freshScene.ownerId;
        await seedSession(here.database, owner);
        const withSessions = [a, b, c, owner].sort();
        const runs = (await here.database.db.select().from(auditEvent)).filter(
          (event) => event.category === AUTH_AUDIT.adminCommandRun,
        ).length;

        const result = await here.runHere('revoke-sessions', '--all');

        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        const counts = new Map([
          [a, 2],
          [b, 1],
          [c, 3],
          [owner, 1],
        ]);
        expect(result.stdout).toBe(
          [
            ...withSessions.map(
              (id) => `${id}: ${sessions(counts.get(id)!)} revoked`,
            ),
            `Revoked ${sessions(7)} of 4 users.`,
          ].join('\n') + '\n',
        );
        // Nobody without a live session is named: not the quiet person, not the
        // one who holds only a token, not the deleted account.
        for (const id of [quiet, tokenOnly, gone]) {
          expect(result.stdout).not.toContain(id);
        }
        // A deleted account cannot sign in; its sessions are left as they were.
        const live = (await here.database.db.select().from(session)).filter(
          (found) => found.revokedAt === null,
        );
        expect(live.map((found) => found.userId)).toEqual([gone, gone]);
        // One event for each person, and one for the command.
        const events = (
          await here.database.db.select().from(auditEvent)
        ).filter((event) => event.category === AUTH_AUDIT.sessionsRevoked);
        expect(events.map((event) => event.targetId).sort()).toEqual(
          withSessions,
        );
        const written = (
          await here.database.db.select().from(auditEvent)
        ).filter((event) => event.category === AUTH_AUDIT.adminCommandRun);
        expect(written).toHaveLength(runs + 1);
        expect(written.at(-1)).toMatchObject({
          details: {
            command: 'revoke-sessions',
            outcome: 'completed',
            users: 4,
            sessionsRevoked: 7,
            tokensRevoked: 0,
            all: true,
            includeApiTokens: false,
          },
        });
      } finally {
        await here.cleanup();
      }
    });

    it('includes the people who hold only a token, and counts the tokens, with --include-api-tokens', async () => {
      const here = await installation();
      try {
        const both = await here.member(1, 2);
        const tokenOnly = await here.member(0, 1);
        const sessionOnly = await here.member(2, 0);
        const ids = [both, tokenOnly, sessionOnly].sort();
        const lines = new Map([
          [both, `${both}: ${sessions(1)} and ${tokens(2)} revoked`],
          [tokenOnly, `${tokenOnly}: ${sessions(0)} and ${tokens(1)} revoked`],
          [
            sessionOnly,
            `${sessionOnly}: ${sessions(2)} and ${tokens(0)} revoked`,
          ],
        ]);

        const result = await here.runHere(
          'revoke-sessions',
          '--all',
          '--include-api-tokens',
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toBe(
          [
            ...ids.map((id) => lines.get(id)!),
            `Revoked ${sessions(3)} and ${tokens(3)} of 3 users.`,
          ].join('\n') + '\n',
        );
        const tokensAfter = await here.database.db.select().from(apiToken);
        expect(tokensAfter).toHaveLength(3);
        for (const found of tokensAfter) {
          expect(found).toMatchObject({
            revokeReason: 'admin-action',
            revokedBy: null,
          });
        }
        // One tokens event for each person whose tokens it ended, with the count, and
        // none for the person who had only sessions.
        const ended = new Map(
          (await here.database.db.select().from(auditEvent))
            .filter((event) => event.category === AUTH_AUDIT.apiTokensRevoked)
            .map((event) => [event.targetId, event.details]),
        );
        expect(ended.size).toBe(2);
        expect(ended.get(both)).toEqual({ reason: 'admin-action', count: 2 });
        expect(ended.get(tokenOnly)).toEqual({
          reason: 'admin-action',
          count: 1,
        });
        expect(ended.has(sessionOnly)).toBe(false);
      } finally {
        await here.cleanup();
      }
    });

    it('says so when nobody has anything live, and still writes its one event', async () => {
      const here = await installation();
      try {
        await here.member(0);

        const result = await here.runHere('revoke-sessions', '--all');

        expect(result.code).toBe(0);
        expect(result.stdout).toBe(`Revoked ${sessions(0)} of 0 users.\n`);
        const [written] = (await here.database.db.select().from(auditEvent))
          .filter((event) => event.category === AUTH_AUDIT.adminCommandRun)
          .slice(-1);
        expect(written!.details).toMatchObject({
          users: 0,
          sessionsRevoked: 0,
          all: true,
        });
      } finally {
        await here.cleanup();
      }
    });
  });

  describe('who it refuses', () => {
    it.each([
      ['an address no one has', ['--email', 'nobody.here@example.test']],
      ['an id no one has', ['--user', '01a21347-bb08-7167-bc54-000000000009']],
    ])(
      '%s: one fixed sentence, no echo, and an event that says so',
      async (_name, args) => {
        const live = (await liveSessions()).length;
        const runs = (await audits(AUTH_AUDIT.adminCommandRun)).length;

        const result = await run('revoke-sessions', ...args);

        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('No account matches.\n');
        expect(await liveSessions()).toHaveLength(live);
        const written = await eventsSince(AUTH_AUDIT.adminCommandRun, runs);
        expect(written).toHaveLength(1);
        expect(written[0]).toMatchObject({
          details: {
            command: 'revoke-sessions',
            outcome: 'refused',
            reason: 'unknown-user',
          },
        });
        expect(JSON.stringify(written)).not.toContain('nobody.here');
      },
    );

    it('an account that was deleted, as no account', async () => {
      const who = await person(1);
      await markUserDeleted(database, who.userId, NOW);

      const result = await run('revoke-sessions', '--user', who.userId);

      expect(result.code).toBe(1);
      expect(result.stderr).toBe('No account matches.\n');
    });
  });

  it('prints only user ids and counts: no name, no address, no token', async () => {
    await person(2, 1);
    await person(1, 1);

    const result = await run(
      'revoke-sessions',
      '--all',
      '--include-api-tokens',
    );

    const shapes = [
      /^[0-9a-f-]{36}: \d+ sessions? and \d+ API tokens? revoked$/,
      /^Revoked \d+ sessions? and \d+ API tokens? of \d+ users?\.$/,
    ];
    for (const line of result.stdout.trimEnd().split('\n')) {
      expect(
        shapes.some((shape) => shape.test(line)),
        line,
      ).toBe(true);
    }
    expect(result.stdout + result.stderr).not.toContain('@');
    expect(result.stdout + result.stderr).not.toContain('osfpm_pat_');
  });
});
