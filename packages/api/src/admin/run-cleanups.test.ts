import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  base,
  grantOnOrganisation,
  seedOrganisation,
} from '@osfpm/core/src/access/test-fixtures.js';
import { createLoginChallenge } from '@osfpm/core/src/auth/login-challenge.js';
import { issueSetupCode } from '@osfpm/core/src/auth/setup-code.js';
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import {
  seedActiveUser,
  seedApiToken,
  seedInstallation,
  seedSession,
} from '@osfpm/core/src/auth/test-support.js';
import type { Database } from '@osfpm/core/src/db/client.js';
import {
  accessReset,
  apiToken,
  auditEvent,
  invite,
  loginChallenge,
  session,
  setupCode,
} from '@osfpm/core/src/db/schema/index.js';
import {
  createMigratedDatabase,
  testTargets,
} from '@osfpm/core/src/db/test-support.js';
import {
  createTestKeyDirectory,
  type TestKeyDirectory,
} from '@osfpm/core/src/keys/test-support.js';
import { TRANSIENT_CLEANUPS } from '@osfpm/core/src/retention/transient-cleanups.js';
import { adminEnvironment, runCommand } from './test-support.js';

/**
 * The `run-cleanups` command (P-09a2, decision D-81): every cleanup of
 * `TRANSIENT_CLEANUPS`, now, with one clock and each in a transaction of its own, the
 * count for each table printed by its name, and one `admin.command-run` with the
 * counts. What each cleanup deletes is tested with it (`transient-cleanups.test.ts`
 * and the cleanup of each table); these tests show the command runs them all, tells
 * the counts, and does not let one that fails stop the others.
 */

const NOW = new Date('2026-06-01T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** The tables, in the order the registry runs them. */
const TABLES = [...TRANSIENT_CLEANUPS.keys()];

describe.each(testTargets)('the run-cleanups command on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let keyDirectory: TestKeyDirectory;

  beforeEach(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    keyDirectory = createTestKeyDirectory();
    await seedInstallation(database);
  });
  afterEach(async () => {
    await cleanup();
    keyDirectory.remove();
  });

  const db = () => database.db;
  const run = () =>
    runCommand(['run-cleanups'], {
      env: adminEnvironment(target.name, keyDirectory.dir),
      database,
      now: () => NOW,
    });

  /** The number of rows each transient table holds. */
  const sizes = async () =>
    new Map<string, number>([
      ['access_reset', (await db().select().from(accessReset)).length],
      ['api_token', (await db().select().from(apiToken)).length],
      ['invite', (await db().select().from(invite)).length],
      ['login_challenge', (await db().select().from(loginChallenge)).length],
      ['session', (await db().select().from(session)).length],
      ['setup_code', (await db().select().from(setupCode)).length],
    ]);

  /** One row of no use in each of the six tables: expired, ended or spent long ago. */
  async function seedWork() {
    const userId = await seedActiveUser(database);
    const memberId = await seedActiveUser(database);
    const { organisationId } = await seedOrganisation(database);
    await grantOnOrganisation(database, organisationId, memberId, 'member', []);
    await seedSession(database, userId, {
      revokedAt: ago(60 * DAY),
      revokedReason: 'logout',
    });
    await createLoginChallenge(db(), userId, {
      kind: 'totp',
      now: ago(60 * DAY),
    });
    await issueSetupCode(db(), ago(60 * DAY));
    await db()
      .insert(invite)
      .values({
        originServer: base(organisationId).originServer,
        organisationId,
        tokenHash: 'cleanup-run-invite',
        tier: 'member',
        createdAt: ago(60 * DAY),
        createdBy: userId,
        expiresAt: ago(53 * DAY),
      });
    await db()
      .insert(accessReset)
      .values({
        originServer: base(organisationId).originServer,
        organisationId,
        userId: memberId,
        tokenHash: 'cleanup-run-reset',
        createdAt: ago(60 * DAY),
        createdBy: userId,
        expiresAt: ago(59 * DAY),
      });
    await seedApiToken(database, organisationId, memberId, {
      expiresAt: new Date('2026-02-01T00:00:00.000Z'),
    });
  }

  it('runs every cleanup of the registry and prints the count of each by the name of its table', async () => {
    await seedWork();
    expect([...(await sizes()).values()]).toEqual([1, 1, 1, 1, 1, 1]);

    const result = await run();

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      TABLES.map((table) => `${table}: 1`).join('\n') + '\n',
    );
    expect([...(await sizes()).values()]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('names every table the registry names, and no other', async () => {
    const result = await run();

    expect(
      result.stdout
        .trimEnd()
        .split('\n')
        .map((line) => line.split(': ')[0]),
    ).toEqual(TABLES);
    // The six tables of working rows today; a new one is in the registry, so it is here.
    expect(TABLES).toEqual([
      'access_reset',
      'api_token',
      'invite',
      'login_challenge',
      'session',
      'setup_code',
    ]);
  });

  it('leaves what is live, and finds nothing the second time', async () => {
    await seedWork();
    const userId = await seedActiveUser(database);
    const live = await seedSession(database, userId);
    await run();

    const second = await run();

    expect(second.stdout).toBe(
      TABLES.map((table) => `${table}: 0`).join('\n') + '\n',
    );
    const kept = await db().select().from(session);
    expect(kept.map((found) => found.id)).toEqual([live]);
  });

  it('writes one admin.command-run with the counts, from the system, and no event for what it deleted', async () => {
    await seedWork();
    const events = (await db().select().from(auditEvent)).length;

    await run();

    const written = (await db().select().from(auditEvent)).filter(
      (event) => event.category === AUTH_AUDIT.adminCommandRun,
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      action: 'run',
      actorType: 'system',
      actorId: null,
      targetType: 'installation',
      details: {
        command: 'run-cleanups',
        outcome: 'completed',
        access_reset: 1,
        api_token: 1,
        invite: 1,
        login_challenge: 1,
        session: 1,
        setup_code: 1,
        failed: 0,
      },
    });
    // A cleanup is housekeeping: the command's one event is the whole trail.
    expect((await db().select().from(auditEvent)).length).toBe(events + 1);
  });

  // The first, a middle and the last entry of the registry: the others must run when
  // any one of them fails.
  it.each([['access_reset'], ['login_challenge'], ['setup_code']])(
    'runs the others and exits 1, naming the table, when the cleanup of %s fails',
    async (broken) => {
      await seedWork();
      // A table that is gone makes its cleanup fail, as a database fault would.
      await db().execute(`drop table "${broken}"`);

      const result = await run();

      expect(result.code).toBe(1);
      const others = TABLES.filter((table) => table !== broken);
      expect(result.stdout).toBe(
        others.map((table) => `${table}: 1`).join('\n') + '\n',
      );
      expect(result.stderr).toBe(
        `The cleanup of ${broken} failed: RecordWriteError (42P01).\n`,
      );
      // What the others had of no use is gone.
      const left = await Promise.all([
        db().select().from(apiToken),
        db().select().from(invite),
        db().select().from(session),
      ]);
      expect(left.map((rows) => rows.length)).toEqual([0, 0, 0]);
      const [written] = (await db().select().from(auditEvent)).filter(
        (event) => event.category === AUTH_AUDIT.adminCommandRun,
      );
      expect(written!.details).toMatchObject({
        command: 'run-cleanups',
        failed: 1,
        failedTables: broken,
      });
      expect(written!.details).not.toHaveProperty(broken);
    },
  );

  it('names two tables when two cleanups fail, and still runs the rest', async () => {
    await seedWork();
    await db().execute('drop table "access_reset"');
    await db().execute('drop table "session"');

    const result = await run();

    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      'The cleanup of access_reset failed: RecordWriteError (42P01).\nThe cleanup of session failed: RecordWriteError (42P01).\n',
    );
    expect(result.stdout).toBe(
      ['api_token', 'invite', 'login_challenge', 'setup_code']
        .map((table) => `${table}: 1`)
        .join('\n') + '\n',
    );
  });

  it('prints no address, no setting and no value: a failure is a class and a code', async () => {
    await db().execute('drop table "api_token"');

    const result = await run();

    expect(result.stderr).toBe(
      'The cleanup of api_token failed: RecordWriteError (42P01).\n',
    );
    expect(result.stderr).not.toContain('select');
    expect(result.stderr).not.toContain('delete');
    expect(result.stderr).not.toContain('postgres://');
  });
});
