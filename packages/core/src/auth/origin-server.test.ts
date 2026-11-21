import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { recoveryCode, session, setupCode, user } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { generateRecoveryCodes } from './recovery.js';
import { createSession } from './sessions.js';
import { issueSetupCode } from './setup-code.js';
import { seedActiveUser, seedInstallation } from './test-support.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');

// Decision (maintainer, P-03b1 review): every row the auth services write is
// stamped with this server's id, read from the single `installation` row. It is
// not passed in by the caller, and not copied from the user: a user may come
// from another server, but a session or a code never leaves this one.
describe.each(testTargets)('origin_server of auth rows on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let serverId: string;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    serverId = await seedInstallation(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;

  it('is the installation id on a session, not the user’s own origin', async () => {
    const userId = await seedActiveUser(database);
    const [owner] = await db().select().from(user).where(eq(user.id, userId));
    // The fixture user comes from a different server than this one.
    expect(owner!.originServer).not.toBe(serverId);
    const { session: created } = await createSession(db(), {
      userId,
      method: 'password',
      now: T0,
    });
    const [row] = await db()
      .select()
      .from(session)
      .where(eq(session.id, created.id));
    expect(row!.originServer).toBe(serverId);
  });

  it('is the installation id on every recovery code', async () => {
    const userId = await seedActiveUser(database);
    await generateRecoveryCodes(db(), userId, { now: T0 });
    const rows = await db()
      .select()
      .from(recoveryCode)
      .where(eq(recoveryCode.userId, userId));
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((row) => row.originServer))).toEqual(
      new Set([serverId]),
    );
  });

  it('is the installation id on a setup code', async () => {
    await issueSetupCode(db(), T0);
    const rows = await db().select().from(setupCode);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.originServer).toBe(serverId);
  });

  it('is refused by all three services while there is no installation row, and nothing is written', async () => {
    const bare = await createMigratedDatabase(target);
    try {
      const userId = await seedActiveUser(bare.database);
      const refusals = await Promise.all(
        [
          createSession(bare.database.db, {
            userId,
            method: 'password',
            now: T0,
          }),
          generateRecoveryCodes(bare.database.db, userId, { now: T0 }),
          issueSetupCode(bare.database.db, T0),
        ].map((attempt) => attempt.catch((error: unknown) => error)),
      );
      for (const refusal of refusals) {
        expect(refusal).toMatchObject({ reason: 'installation-missing' });
      }
      expect(await bare.database.db.select().from(session)).toEqual([]);
      expect(await bare.database.db.select().from(recoveryCode)).toEqual([]);
      expect(await bare.database.db.select().from(setupCode)).toEqual([]);
    } finally {
      await bare.cleanup();
    }
  });
});
