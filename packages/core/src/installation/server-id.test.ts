import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedInstallation } from '../auth/test-support.js';
import type { Database } from '../db/client.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
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
