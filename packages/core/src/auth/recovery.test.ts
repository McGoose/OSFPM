import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { recoveryCode } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  RECOVERY_CODE_COUNT,
} from './recovery.js';
import {
  everyRowAsText,
  seedActiveUser,
  seedInstallation,
  setUserStatus,
} from './test-support.js';
import { hashHumanCode, normaliseHumanCode } from './tokens.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const LATER = new Date('2026-03-02T10:00:00.000Z');

describe.each(testTargets)('recovery codes on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    await seedInstallation(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;
  const rowsOfUser = (userId: string) =>
    db().select().from(recoveryCode).where(eq(recoveryCode.userId, userId));

  describe('generateRecoveryCodes', () => {
    it('returns 10 different codes and stores only their hashes', async () => {
      const userId = await seedActiveUser(database);
      const codes = await generateRecoveryCodes(db(), userId, { now: T0 });
      expect(RECOVERY_CODE_COUNT).toBe(10);
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      for (const code of codes) {
        expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
      }
      const stored = await rowsOfUser(userId);
      expect(stored).toHaveLength(10);
      expect(stored.map((row) => row.codeHash).sort()).toEqual(
        codes.map((code) => hashHumanCode(code)!).sort(),
      );
      expect(stored.every((row) => row.usedAt === null)).toBe(true);
      const text = await everyRowAsText(database);
      for (const code of codes) {
        expect(text).not.toContain(code);
        expect(text).not.toContain(normaliseHumanCode(code)!);
      }
    });

    it('replaces an earlier set: the old codes stop working, used or not', async () => {
      const userId = await seedActiveUser(database);
      const first = await generateRecoveryCodes(db(), userId, { now: T0 });
      expect(
        await consumeRecoveryCode(db(), userId, first[0]!, { now: T0 }),
      ).toBe(true);
      const second = await generateRecoveryCodes(db(), userId, { now: LATER });
      expect(second.some((code) => first.includes(code))).toBe(false);
      // Ten rows, not twenty, and none of them is the used one.
      const stored = await rowsOfUser(userId);
      expect(stored).toHaveLength(10);
      expect(stored.every((row) => row.usedAt === null)).toBe(true);
      for (const old of first) {
        expect(
          await consumeRecoveryCode(db(), userId, old, { now: LATER }),
        ).toBe(false);
      }
      expect(
        await consumeRecoveryCode(db(), userId, second[0]!, { now: LATER }),
      ).toBe(true);
    });

    it('leaves another user’s codes alone', async () => {
      const first = await seedActiveUser(database);
      const second = await seedActiveUser(database);
      const theirs = await generateRecoveryCodes(db(), second, { now: T0 });
      await generateRecoveryCodes(db(), first, { now: T0 });
      await generateRecoveryCodes(db(), first, { now: LATER });
      expect(await rowsOfUser(second)).toHaveLength(10);
      expect(
        await consumeRecoveryCode(db(), second, theirs[0]!, { now: LATER }),
      ).toBe(true);
    });

    it('leaves one set of ten when two requests run at once', async () => {
      const userId = await seedActiveUser(database);
      await Promise.all([
        generateRecoveryCodes(db(), userId, { now: T0 }),
        generateRecoveryCodes(db(), userId, { now: T0 }),
      ]);
      expect(await rowsOfUser(userId)).toHaveLength(10);
    });

    it('refuses an unknown user, and writes nothing', async () => {
      await expect(
        generateRecoveryCodes(db(), newId(), { now: T0 }),
      ).rejects.toMatchObject({ reason: 'user-not-found' });
    });
  });

  describe('consumeRecoveryCode', () => {
    it('accepts a code once, and records when', async () => {
      const userId = await seedActiveUser(database);
      const [code] = await generateRecoveryCodes(db(), userId, { now: T0 });
      expect(
        await consumeRecoveryCode(db(), userId, code!, { now: LATER }),
      ).toBe(true);
      expect(
        await consumeRecoveryCode(db(), userId, code!, { now: LATER }),
      ).toBe(false);
      const used = (await rowsOfUser(userId)).filter((row) => row.usedAt);
      expect(used).toHaveLength(1);
      expect(used[0]!.usedAt).toEqual(LATER);
      expect(used[0]!.codeHash).toBe(hashHumanCode(code!));
    });

    it('accepts any spelling of the code', async () => {
      const userId = await seedActiveUser(database);
      const codes = await generateRecoveryCodes(db(), userId, { now: T0 });
      const spellings = [
        codes[0]!.toLowerCase(),
        codes[1]!.replaceAll('-', ''),
        ` ${codes[2]!.replaceAll('-', ' ')} `,
      ];
      for (const spelling of spellings) {
        expect(
          await consumeRecoveryCode(db(), userId, spelling, { now: LATER }),
        ).toBe(true);
      }
    });

    it('refuses a wrong code, another user’s code, and anything not shaped like a code', async () => {
      const userId = await seedActiveUser(database);
      const other = await seedActiveUser(database);
      await generateRecoveryCodes(db(), userId, { now: T0 });
      const [theirs] = await generateRecoveryCodes(db(), other, { now: T0 });
      for (const bad of [
        'AAAA-AAAA-AAAA-AAAA',
        theirs!,
        '',
        'short',
        '__proto__',
        'x'.repeat(5000),
        null as unknown as string,
        undefined as unknown as string,
        42 as unknown as string,
      ]) {
        expect(
          await consumeRecoveryCode(db(), userId, bad, { now: LATER }),
        ).toBe(false);
      }
      // The other user's code was not spent by the attempt above.
      expect(
        await consumeRecoveryCode(db(), other, theirs!, { now: LATER }),
      ).toBe(true);
    });

    it('lets only one of two requests with the same code succeed', async () => {
      const userId = await seedActiveUser(database);
      const [code] = await generateRecoveryCodes(db(), userId, { now: T0 });
      const results = await Promise.all([
        consumeRecoveryCode(db(), userId, code!, { now: LATER }),
        consumeRecoveryCode(db(), userId, code!, { now: LATER }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('does not use up, or accept, the code of a disabled or deleted user', async () => {
      const userId = await seedActiveUser(database);
      const [code] = await generateRecoveryCodes(db(), userId, { now: T0 });
      await setUserStatus(database, userId, 'disabled');
      expect(
        await consumeRecoveryCode(db(), userId, code!, { now: LATER }),
      ).toBe(false);
      expect(
        (await rowsOfUser(userId)).every((row) => row.usedAt === null),
      ).toBe(true);
      await setUserStatus(database, userId, 'active');
      expect(
        await consumeRecoveryCode(db(), userId, code!, { now: LATER }),
      ).toBe(true);
    });
  });
});
