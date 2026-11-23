import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  grantOnOrganisation,
  ORIGIN,
  seedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { apiToken, auditEvent } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { cleanupApiTokens } from './api-token-cleanup.js';
import { seedActiveUser } from './test-support.js';

/**
 * `cleanupApiTokens`: the worker's housekeeping for the `api_token` table, which is
 * `transient`. Rows are written directly, as fixtures do; the service that writes
 * them is tested in `api-tokens.test.ts`.
 */

const NOW = new Date('2026-06-01T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

let counter = 0;

describe.each(testTargets)('cleanupApiTokens on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let organisationId: string;
  let ownerId: string;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    organisationId = (await seedOrganisation(database)).organisationId;
    ownerId = await seedActiveUser(database);
    await grantOnOrganisation(database, organisationId, ownerId, 'member', []);
  });
  afterAll(async () => {
    await cleanup();
  });

  /** A token row, written directly. Its name says what it is. */
  const seed = async (
    name: string,
    overrides: Partial<typeof apiToken.$inferInsert> = {},
  ) => {
    counter += 1;
    const [row] = await database.db
      .insert(apiToken)
      .values({
        originServer: ORIGIN,
        organisationId,
        userId: ownerId,
        name,
        prefix: `osfpm_pat_cleanup${counter}`,
        tokenHash: `cleanup-hash-${counter}`,
        access: 'read',
        createdAt: ago(60 * DAY),
        createdBy: ownerId,
        ...overrides,
      })
      .returning();
    return row!;
  };

  it('deletes the tokens that were revoked or have expired, and keeps every one that is live', async () => {
    const liveForEver = await seed('live, never expires');
    const liveTimed = await seed('live, with time left', {
      expiresAt: ahead(30 * DAY),
    });
    await seed('expired', { expiresAt: ago(DAY) });
    // Ending exactly now counts as expired, as `authenticateApiToken` counts it.
    await seed('ends now', { expiresAt: NOW });
    await seed('revoked, never expires', {
      revokedAt: ago(DAY),
      revokeReason: 'manual',
      revokedBy: ownerId,
    });
    await seed('revoked, with time left', {
      expiresAt: ahead(30 * DAY),
      revokedAt: ago(DAY),
      revokeReason: 'switch-off',
    });

    expect(await cleanupApiTokens(database.db, NOW)).toBe(4);

    const left = await database.db.select().from(apiToken);
    expect(left.map((row) => row.id).sort()).toEqual(
      [liveForEver.id, liveTimed.id].sort(),
    );
    // Nothing left to delete the second time.
    expect(await cleanupApiTokens(database.db, NOW)).toBe(0);
  });

  it('is housekeeping: it writes no audit event, and returns 0 for an empty table', async () => {
    await database.db.delete(apiToken);
    const before = (await database.db.select().from(auditEvent)).length;
    expect(await cleanupApiTokens(database.db, NOW)).toBe(0);
    await seed('expired again', { expiresAt: ago(DAY) });
    expect(await cleanupApiTokens(database.db, NOW)).toBe(1);
    expect((await database.db.select().from(auditEvent)).length).toBe(before);
  });
});
