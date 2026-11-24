import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { Database } from '../db/client.js';
import { auditEvent, installation } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { ServerKeysError } from '../keys/errors.js';
import { loadServerKeys, SERVER_KEY_FILES } from '../keys/server-keys.js';
import {
  createTestKeyDirectory,
  type TestKeyDirectory,
} from '../keys/test-support.js';
import { bindServerKeys } from './server-key-binding.js';
import { AUTH_AUDIT } from './shared.js';
import { seedInstallation } from './test-support.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const T1 = new Date('2026-03-03T09:00:00.000Z');

describe.each(testTargets)('bindServerKeys on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scratch: TestKeyDirectory;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
  });
  afterAll(async () => {
    await cleanup();
  });
  // The single-row index makes the row global, so every test starts with a fresh one.
  beforeEach(async () => {
    await database.db.delete(installation);
    scratch = createTestKeyDirectory();
  });
  afterEach(() => scratch.remove());

  const db = () => database.db;
  const storedKey = async () =>
    (await db().select().from(installation))[0]?.serverPublicKey;
  // Audit events are append-only and the database is shared, so each test reads
  // the events about its own installation row (a new id every time).
  const boundEvents = async (installationId: string) =>
    (await db().select().from(auditEvent)).filter(
      (event) =>
        event.category === AUTH_AUDIT.serverKeyBound &&
        event.targetId === installationId,
    );

  it('stores the identity public key the first time, and writes one audit event', async () => {
    const id = await seedInstallation(database);

    const bound = await bindServerKeys(db(), { keysDir: scratch.dir, now: T0 });

    expect(bound.identityBound).toBe(true);
    expect(await storedKey()).toBe(bound.keys.identity.publicKey);
    // The raw 32-byte key in base64url, which is 43 characters.
    expect(bound.keys.identity.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const events = await boundEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'system',
      targetType: 'installation',
      targetId: id,
      occurredAt: T0,
      details: {
        algorithm: 'Ed25519',
        fingerprint: bound.keys.identity.fingerprint,
      },
    });
  });

  it('does nothing at the next start: the same key, no new event', async () => {
    const id = await seedInstallation(database);
    const first = await bindServerKeys(db(), { keysDir: scratch.dir, now: T0 });

    const second = await bindServerKeys(db(), {
      keysDir: scratch.dir,
      now: T1,
    });

    expect(second.identityBound).toBe(false);
    expect(second.keys.identity.publicKey).toBe(first.keys.identity.publicKey);
    expect(second.keys.dataKeys.currentKeyId).toBe(
      first.keys.dataKeys.currentKeyId,
    );
    expect(await storedKey()).toBe(first.keys.identity.publicKey);
    expect(await boundEvents(id)).toHaveLength(1);
  });

  it('refuses a key directory that does not belong to this database, and never replaces the stored key', async () => {
    const id = await seedInstallation(database);
    const first = await bindServerKeys(db(), { keysDir: scratch.dir, now: T0 });
    const stranger = createTestKeyDirectory();
    try {
      const error = await bindServerKeys(db(), {
        keysDir: stranger.dir,
        now: T1,
      }).catch((caught: unknown) => caught);
      // The directory has no identity file, which the database has a key for.
      expect(error).toBeInstanceOf(ServerKeysError);
      expect((error as ServerKeysError).reason).toBe('identity-missing');
      expect(existsSync(join(stranger.dir, SERVER_KEY_FILES.identity))).toBe(
        false,
      );

      // And a directory that has an identity key of its own.
      loadServerKeys(stranger.dir);
      const mismatch = await bindServerKeys(db(), {
        keysDir: stranger.dir,
        now: T1,
      }).catch((caught: unknown) => caught);
      expect(mismatch).toBeInstanceOf(ServerKeysError);
      expect((mismatch as ServerKeysError).reason).toBe('identity-mismatch');
      expect((mismatch as ServerKeysError).message).toContain(
        'Restore the matching keys',
      );
    } finally {
      stranger.remove();
    }
    expect(await storedKey()).toBe(first.keys.identity.publicKey);
    expect(await boundEvents(id)).toHaveLength(1);
  });

  it('refuses when the identity file is gone but the database has a key, and makes no new one', async () => {
    await seedInstallation(database);
    const first = await bindServerKeys(db(), { keysDir: scratch.dir, now: T0 });
    rmSync(join(scratch.dir, SERVER_KEY_FILES.identity));

    const error = await bindServerKeys(db(), {
      keysDir: scratch.dir,
      now: T1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServerKeysError);
    expect((error as ServerKeysError).reason).toBe('identity-missing');
    expect(existsSync(join(scratch.dir, SERVER_KEY_FILES.identity))).toBe(
      false,
    );
    expect(await storedKey()).toBe(first.keys.identity.publicKey);
  });

  it('binds the key a restored directory holds when the database has none yet', async () => {
    await seedInstallation(database);
    const earlier = loadServerKeys(scratch.dir);

    const bound = await bindServerKeys(db(), { keysDir: scratch.dir, now: T0 });

    expect(bound.keys.identity.publicKey).toBe(earlier.identity.publicKey);
    expect(await storedKey()).toBe(earlier.identity.publicKey);
  });

  it('stops with an auth error when there is no installation row yet', async () => {
    await expect(
      bindServerKeys(db(), { keysDir: scratch.dir, now: T0 }),
    ).rejects.toMatchObject({ reason: 'installation-missing' });
    // Nothing was made in the key directory.
    expect(existsSync(join(scratch.dir, SERVER_KEY_FILES.identity))).toBe(
      false,
    );
  });

  it('never puts a private key, a data key or a path into the audit trail or the row', async () => {
    await seedInstallation(database);
    const bound = await bindServerKeys(db(), { keysDir: scratch.dir, now: T0 });
    const everything = JSON.stringify({
      events: await db().select().from(auditEvent),
      rows: await db().select().from(installation),
    });
    expect(everything).not.toContain('PRIVATE KEY');
    expect(everything).not.toContain(scratch.dir);
    expect(everything).not.toContain(bound.keys.dataKeys.currentKeyId);
    expect(everything).not.toContain(SERVER_KEY_FILES.identity);
  });
});
