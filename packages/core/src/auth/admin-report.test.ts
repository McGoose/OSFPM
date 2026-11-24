import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedOrganisation } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { auditEvent, installation, organisation } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { publicKeyFingerprint } from '../keys/identity.js';
import { loadServerKeys } from '../keys/server-keys.js';
import {
  createTestKeyDirectory,
  type TestKeyDirectory,
} from '../keys/test-support.js';
import {
  readInstallationFacts,
  recordAdminCommandRun,
} from './admin-report.js';
import { bindServerKeys } from './server-key-binding.js';
import { AUTH_AUDIT } from './shared.js';
import {
  markSetupComplete,
  markUserDeleted,
  seedActiveUser,
  seedInstallation,
  seedTotp,
  seedUserWithStatus,
  setStoredTotpSecret,
  storedTotpSecret,
} from './test-support.js';
import { countTotpSecrets } from './totp.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');

/**
 * What the admin command line asks about an installation: the facts it reports
 * (`readInstallationFacts`), the counts of authenticator secrets by state
 * (`countTotpSecrets`) and the one event it writes (`recordAdminCommandRun`).
 */
describe.each(testTargets)('the admin report on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scratch: TestKeyDirectory;
  const stray: TestKeyDirectory[] = [];

  beforeEach(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    scratch = createTestKeyDirectory();
  });
  afterEach(async () => {
    await cleanup();
    scratch.remove();
  });
  afterAll(() => stray.forEach((directory) => directory.remove()));

  const db = () => database.db;
  const events = async () =>
    (await db().select().from(auditEvent)).filter(
      (event) => event.category === AUTH_AUDIT.adminCommandRun,
    );

  describe('readInstallationFacts', () => {
    it('answers nothing, and zero counts, before the server has made the installation', async () => {
      expect(await readInstallationFacts(db())).toEqual({
        installationId: null,
        setupCompletedAt: null,
        storedPublicKey: null,
        storedFingerprint: null,
        organisations: 0,
        users: { invited: 0, active: 0, disabled: 0, deleted: 0 },
      });
    });

    it('answers the installation, its stored key and its fingerprint, and when setup finished', async () => {
      const id = await seedInstallation(database);
      const { keys } = await bindServerKeys(db(), {
        keysDir: scratch.dir,
        now: T0,
      });
      await markSetupComplete(database, T0);

      const facts = await readInstallationFacts(db());

      expect(facts).toMatchObject({
        installationId: id,
        setupCompletedAt: T0,
        storedPublicKey: keys.identity.publicKey,
        storedFingerprint: keys.identity.fingerprint,
      });
      expect(facts.storedFingerprint).toBe(
        publicKeyFingerprint(facts.storedPublicKey!),
      );
    });

    it('counts the organisations and the users by status, and leaves the deleted ones out of their status', async () => {
      await seedInstallation(database);
      await seedOrganisation(database);
      await seedOrganisation(database);
      await seedActiveUser(database);
      await seedActiveUser(database);
      await seedUserWithStatus(database, 'invited');
      await seedUserWithStatus(database, 'disabled');
      await seedUserWithStatus(database, 'disabled');
      const gone = await seedUserWithStatus(database, 'disabled');
      await markUserDeleted(database, gone, T0);

      const facts = await readInstallationFacts(db());

      expect(facts.organisations).toBe(2);
      expect(facts.users).toEqual({
        invited: 1,
        active: 2,
        disabled: 2,
        deleted: 1,
      });
    });

    it('does not count an organisation that is deleted', async () => {
      await seedInstallation(database);
      await seedOrganisation(database);
      await db().update(organisation).set({ deletedAt: T0 });

      expect((await readInstallationFacts(db())).organisations).toBe(0);
    });

    it('returns no name and no address of anyone', async () => {
      await seedInstallation(database);
      await seedActiveUser(database);

      const text = JSON.stringify(await readInstallationFacts(db()));

      expect(text).not.toContain('@');
      expect(text).not.toContain('Fixture');
    });
  });

  describe('countTotpSecrets', () => {
    it('counts nothing for no secrets', async () => {
      const { dataKeys } = loadServerKeys(scratch.dir);

      expect(await countTotpSecrets(db(), dataKeys)).toEqual({
        sealed: 0,
        plain: 0,
        unopenable: 0,
      });
    });

    it('counts sealed, plain and sealed-but-unopenable secrets, confirmed or not, and nothing else', async () => {
      const { dataKeys } = loadServerKeys(scratch.dir);
      const other = createTestKeyDirectory();
      stray.push(other);
      const stranger = loadServerKeys(other.dir).dataKeys;
      await seedTotp(database, await seedActiveUser(database), {
        dataKeys,
        now: T0,
      });
      await seedTotp(database, await seedActiveUser(database), {
        dataKeys,
        now: T0,
        confirmed: false,
      });
      await seedTotp(database, await seedActiveUser(database), {
        dataKeys,
        now: T0,
        plain: true,
      });
      await seedTotp(database, await seedActiveUser(database), {
        dataKeys: stranger,
        now: T0,
      });

      const counts = await countTotpSecrets(db(), dataKeys);

      expect(counts).toEqual({ sealed: 3, plain: 1, unopenable: 1 });
      expect(Object.keys(counts).sort()).toEqual([
        'plain',
        'sealed',
        'unopenable',
      ]);
    });

    it('counts every sealed secret as unopenable when there is no ring', async () => {
      const { dataKeys } = loadServerKeys(scratch.dir);
      await seedTotp(database, await seedActiveUser(database), {
        dataKeys,
        now: T0,
      });
      await seedTotp(database, await seedActiveUser(database), {
        dataKeys,
        now: T0,
        plain: true,
      });

      expect(await countTotpSecrets(db(), null)).toEqual({
        sealed: 1,
        plain: 1,
        unopenable: 1,
      });
    });

    it('counts a sealed secret copied to another user’s row as one that cannot be opened', async () => {
      const { dataKeys } = loadServerKeys(scratch.dir);
      const owner = await seedActiveUser(database);
      const other = await seedActiveUser(database);
      await seedTotp(database, owner, { dataKeys, now: T0 });
      await seedTotp(database, other, { dataKeys, now: T0 });
      // The ciphertext made for one row, on another row.
      await setStoredTotpSecret(
        database,
        other,
        await storedTotpSecret(database, owner),
      );

      expect(await countTotpSecrets(db(), dataKeys)).toEqual({
        sealed: 2,
        plain: 0,
        unopenable: 1,
      });
    });

    it('writes nothing', async () => {
      const { dataKeys } = loadServerKeys(scratch.dir);
      await seedTotp(database, await seedActiveUser(database), {
        dataKeys,
        now: T0,
      });
      const before = JSON.stringify(await db().select().from(auditEvent));

      await countTotpSecrets(db(), dataKeys);

      expect(JSON.stringify(await db().select().from(auditEvent))).toBe(before);
    });
  });

  describe('recordAdminCommandRun', () => {
    it('writes one event from the system about the installation, with the command, the outcome and the counts', async () => {
      const id = await seedInstallation(database);

      await recordAdminCommandRun(db(), {
        command: 'doctor',
        outcome: 'completed',
        installationId: id,
        details: { ok: 9, warn: 1, fail: 0, skipped: 1 },
        now: T0,
      });

      const [event, ...rest] = await events();
      expect(rest).toEqual([]);
      expect(event).toMatchObject({
        category: 'admin.command-run',
        action: 'run',
        actorType: 'system',
        actorId: null,
        targetType: 'installation',
        targetId: id,
        organisationId: null,
        occurredAt: T0,
        details: {
          command: 'doctor',
          outcome: 'completed',
          ok: 9,
          warn: 1,
          fail: 0,
          skipped: 1,
        },
      });
    });

    it('writes an event with no target before the installation exists', async () => {
      await recordAdminCommandRun(db(), {
        command: 'info',
        outcome: 'completed',
        installationId: null,
        now: T0,
      });

      const [event] = await events();
      expect(event).toMatchObject({ targetType: null, targetId: null });
      expect(event!.details).toEqual({ command: 'info', outcome: 'completed' });
    });

    it('does not let a detail replace the command or the outcome', async () => {
      await recordAdminCommandRun(db(), {
        command: 'info',
        outcome: 'refused',
        installationId: null,
        details: { command: 'something else', outcome: 'completed', count: 2 },
        now: T0,
      });

      const [event] = await events();
      expect(event!.details).toEqual({
        command: 'info',
        outcome: 'refused',
        count: 2,
      });
    });

    it('is in the same transaction as the caller, so a failure after it takes it back', async () => {
      await expect(
        db().transaction(async (tx) => {
          await recordAdminCommandRun(tx, {
            command: 'info',
            outcome: 'completed',
            installationId: null,
            now: T0,
          });
          throw new Error('after the event');
        }),
      ).rejects.toThrow('after the event');

      expect(await events()).toEqual([]);
    });
  });

  it('leaves the installation row as it was', async () => {
    await seedInstallation(database);
    const before = await db().select().from(installation);

    await readInstallationFacts(db());
    await recordAdminCommandRun(db(), {
      command: 'info',
      outcome: 'completed',
      installationId: before[0]!.id,
      now: T0,
    });

    expect(await db().select().from(installation)).toEqual(before);
  });
});
