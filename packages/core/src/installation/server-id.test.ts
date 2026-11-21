import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedInstallation } from '../auth/test-support.js';
import type { Database } from '../db/client.js';
import {
  createMigratedDatabase,
  interleave,
  testTargets,
} from '../db/test-support.js';
import { getServerId, InstallationMissingError } from './server-id.js';

describe.each(testTargets)('getServerId on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
  });
  afterAll(async () => {
    await cleanup();
  });

  // The database starts with no installation row, so this runs first, and the
  // tests after it set one up.
  it('throws InstallationMissingError before there is an installation row, and the error carries nothing', async () => {
    const error = await getServerId(database.db).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(InstallationMissingError);
    expect((error as Error).name).toBe('InstallationMissingError');
    expect((error as Error).message).toBe('There is no installation yet');
  });

  it('returns the id of the one installation row, which is the id of this server', async () => {
    const installationId = await seedInstallation(database);
    expect(await getServerId(database.db)).toBe(installationId);
    // The same every time: the id never changes.
    expect(await getServerId(database.db)).toBe(installationId);
  });

  it('works in a transaction, with the row held until it ends when asked to', async () => {
    const installationId = await getServerId(database.db);
    expect(await database.db.transaction((tx) => getServerId(tx))).toBe(
      installationId,
    );
    expect(
      await database.db.transaction((tx) => getServerId(tx, { lock: true })),
    ).toBe(installationId);
  });
});

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/**
 * `lock` holds the installation row until the transaction ends, which is what
 * lets the setup code serialise on it. Only a server with real concurrent
 * sessions can show that, so these run on PostgreSQL and are skipped on PGlite.
 */
describe.skipIf(postgres === undefined)(
  'getServerId with lock, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
      await seedInstallation(database);
    });
    afterAll(async () => {
      await cleanup();
    });

    it('makes a second caller that also locks wait until the first transaction ends', async () => {
      // `interleave` fails the test if the second caller does not block.
      const outcomes = await interleave(
        database.db,
        (tx) => getServerId(tx, { lock: true }),
        (tx) => getServerId(tx, { lock: true }),
      );
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ]);
    });

    it('does not make a plain read wait for the holder', async () => {
      let holding!: () => void;
      const hasLock = new Promise<void>((resolve) => {
        holding = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = database.db.transaction(async (tx) => {
        await getServerId(tx, { lock: true });
        holding();
        await released;
      });
      await hasLock;
      try {
        expect(typeof (await getServerId(database.db))).toBe('string');
      } finally {
        release();
        await holder;
      }
    });
  },
);
