import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { installation, setupCode } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';
import {
  consumeSetupCode,
  isSetupComplete,
  issueSetupCode,
  SETUP_CODE_LIFETIME_MS,
} from './setup-code.js';
import { everyRowAsText, seedInstallation } from './test-support.js';
import { hashHumanCode } from './tokens.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 60 * 60 * 1000;

describe.each(testTargets)('setup codes on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
  });
  afterAll(async () => {
    await cleanup();
  });
  // The partial unique index makes the live code global, so every test starts
  // with no codes and a fresh installation row.
  beforeEach(async () => {
    await database.db.delete(setupCode);
    await database.db.delete(installation);
    await seedInstallation(database);
  });

  const db = () => database.db;
  const stored = () => db().select().from(setupCode);

  describe('issueSetupCode', () => {
    it('returns the raw code once and stores only its hash, expiring after 24 hours', async () => {
      const code = await issueSetupCode(db(), T0);
      expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
      expect(SETUP_CODE_LIFETIME_MS).toBe(24 * HOUR);
      const [row, ...rest] = await stored();
      expect(rest).toEqual([]);
      expect(row!.codeHash).toBe(hashHumanCode(code));
      expect(row!.expiresAt).toEqual(at(24 * HOUR));
      expect(row!.createdAt).toEqual(T0);
      expect(row!.usedAt).toBeNull();
      expect(row!.revokedAt).toBeNull();
      const text = await everyRowAsText(database);
      expect(text).not.toContain(code);
      expect(text).not.toContain(code.replaceAll('-', ''));
    });

    it('revokes the earlier live code, so only the newest works', async () => {
      const first = await issueSetupCode(db(), T0);
      const second = await issueSetupCode(db(), at(HOUR));
      expect(second).not.toBe(first);
      const rows = await stored();
      expect(rows).toHaveLength(2);
      const byHash = new Map(rows.map((row) => [row.codeHash, row]));
      expect(byHash.get(hashHumanCode(first)!)!.revokedAt).toEqual(at(HOUR));
      expect(byHash.get(hashHumanCode(second)!)!.revokedAt).toBeNull();
      expect(await consumeSetupCode(db(), first, at(2 * HOUR))).toBe(false);
      expect(await consumeSetupCode(db(), second, at(2 * HOUR))).toBe(true);
    });

    it('also replaces a code that has expired but was never used', async () => {
      await issueSetupCode(db(), T0);
      const fresh = await issueSetupCode(db(), at(48 * HOUR));
      expect(await consumeSetupCode(db(), fresh, at(49 * HOUR))).toBe(true);
    });

    it('can issue a new code after the last one was used, while setup is not complete', async () => {
      const first = await issueSetupCode(db(), T0);
      expect(await consumeSetupCode(db(), first, at(HOUR))).toBe(true);
      const second = await issueSetupCode(db(), at(2 * HOUR));
      expect(await consumeSetupCode(db(), second, at(3 * HOUR))).toBe(true);
    });

    it('leaves one live code when two requests run at once', async () => {
      await Promise.all([issueSetupCode(db(), T0), issueSetupCode(db(), T0)]);
      const live = (await stored()).filter(
        (row) => row.usedAt === null && row.revokedAt === null,
      );
      expect(live).toHaveLength(1);
    });

    it('refuses once setup is complete, and issues nothing', async () => {
      await db().update(installation).set({ setupCompletedAt: T0 });
      await expect(issueSetupCode(db(), at(HOUR))).rejects.toMatchObject({
        reason: 'setup-complete',
      });
      expect(await stored()).toEqual([]);
    });

    it('refuses before the installation row exists', async () => {
      await db().delete(installation);
      await expect(issueSetupCode(db(), T0)).rejects.toMatchObject({
        reason: 'installation-missing',
      });
    });
  });

  describe('consumeSetupCode', () => {
    it('accepts the live code once, and records when', async () => {
      const code = await issueSetupCode(db(), T0);
      expect(await consumeSetupCode(db(), code, at(HOUR))).toBe(true);
      expect(await consumeSetupCode(db(), code, at(2 * HOUR))).toBe(false);
      const [row] = await stored();
      expect(row!.usedAt).toEqual(at(HOUR));
    });

    it('accepts any spelling of the code', async () => {
      const code = await issueSetupCode(db(), T0);
      expect(
        await consumeSetupCode(
          db(),
          code.toLowerCase().replaceAll('-', ' '),
          at(HOUR),
        ),
      ).toBe(true);
    });

    it('works until the expiry, and not at it', async () => {
      const code = await issueSetupCode(db(), T0);
      expect(await consumeSetupCode(db(), code, at(24 * HOUR))).toBe(false);
      expect(await consumeSetupCode(db(), code, at(24 * HOUR + 1))).toBe(false);
      const again = await issueSetupCode(db(), at(25 * HOUR));
      expect(
        await consumeSetupCode(db(), again, at(25 * HOUR + 24 * HOUR - 1)),
      ).toBe(true);
    });

    it('refuses a wrong code and anything not shaped like a code', async () => {
      const code = await issueSetupCode(db(), T0);
      for (const bad of [
        'AAAA-AAAA-AAAA-AAAA',
        '',
        'short',
        '__proto__',
        'x'.repeat(5000),
        null as unknown as string,
        42 as unknown as string,
      ]) {
        expect(await consumeSetupCode(db(), bad, at(HOUR))).toBe(false);
      }
      // The wrong guesses did not spend the real code.
      expect(await consumeSetupCode(db(), code, at(HOUR))).toBe(true);
    });

    it('lets only one of two requests with the same code succeed', async () => {
      const code = await issueSetupCode(db(), T0);
      const results = await Promise.all([
        consumeSetupCode(db(), code, at(HOUR)),
        consumeSetupCode(db(), code, at(HOUR)),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('refuses once setup is complete, even for a code that is still live', async () => {
      const code = await issueSetupCode(db(), T0);
      await db()
        .update(installation)
        .set({ setupCompletedAt: at(HOUR) });
      expect(await consumeSetupCode(db(), code, at(2 * HOUR))).toBe(false);
      const [row] = await stored();
      expect(row!.usedAt).toBeNull();
    });

    it('refuses before the installation row exists', async () => {
      await db().delete(installation);
      expect(await consumeSetupCode(db(), 'AAAA-AAAA-AAAA-AAAA', T0)).toBe(
        false,
      );
    });
  });

  describe('isSetupComplete', () => {
    it('is false until setup_completed_at is set, and false with no installation row', async () => {
      expect(await isSetupComplete(db())).toBe(false);
      await db()
        .update(installation)
        .set({ setupCompletedAt: T0 })
        .where(eq(installation.baseUrl, 'https://osfpm.example.test'));
      expect(await isSetupComplete(db())).toBe(true);
      await db().delete(installation);
      expect(await isSetupComplete(db())).toBe(false);
    });
  });

  it('rejects a second live code straight into the table, by the partial unique index', async () => {
    await issueSetupCode(db(), T0);
    const [live] = await stored();
    const failure = await failureOf(() =>
      db()
        .insert(setupCode)
        .values({
          originServer: live!.originServer,
          codeHash: 'a-second-live-hash',
          expiresAt: at(HOUR),
          createdAt: T0,
          updatedAt: T0,
        }),
    );
    expect(failure).toEqual({
      code: SQLSTATE.uniqueViolation,
      constraint: 'setup_code_single_live',
    });
  });
});
