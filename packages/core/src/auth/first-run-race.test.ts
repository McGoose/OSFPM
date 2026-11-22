import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import {
  auditEvent,
  organisation,
  orgMembership,
  setupCode,
  user,
} from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  testTargets,
} from '../db/test-support.js';
import { completeFirstRunSetup } from './first-run-setup.js';
import { issueSetupCode } from './setup-code.js';
import { AUTH_AUDIT } from './shared.js';
import { demoSetupInput, seedFirstRun } from './test-support.js';

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

const FIRST = 'first.person@demopictures.example';
const SECOND = 'second.person@demopictures.example';

/**
 * First-run setup against itself, on two real connections. Setup takes the
 * `installation` row lock (`lockInstallation`) before it spends the code or
 * writes anything, so whichever of two comes second waits for the first and then
 * sees what it did. Only a server with real concurrent sessions can show that,
 * so the tests run on PostgreSQL and are skipped on PGlite.
 *
 * `interleave` fixes the order: the first piece of work runs to its end and
 * keeps its transaction open, the second starts and must block on a lock, and
 * only then does the first commit.
 *
 * Two guards stand between a second setup and the first, and they are different.
 * Two setups with the same code are also stopped by the single conditional
 * UPDATE that spends the code, so the lock is not the only thing that refuses
 * the second (the first test). What only the lock decides is whether a setup and
 * the start-up of a server that issues a code at the same moment leave a live
 * code behind (the second test), which is why that is tested separately.
 */
describe.skipIf(postgres === undefined)(
  'first-run setup racing itself, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let code: string;

    // Setup completes in every test, so each has a database of its own.
    beforeEach(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
      code = await seedFirstRun(database, T0);
    });
    afterEach(async () => {
      await cleanup();
    });

    const db = () => database.db;
    const count = async (table: typeof organisation | typeof user) =>
      (await db().select().from(table)).length;

    /** What must be true however the race went: one organisation, one user, one owner. */
    async function expectOneSetup() {
      expect(await count(organisation)).toBe(1);
      expect(await count(user)).toBe(1);
      const owners = (await db().select().from(orgMembership)).filter(
        (member) => member.orgRole === 'owner',
      );
      expect(owners).toHaveLength(1);
    }

    it('lets one of two setups with the same code succeed, and refuses the other as an invalid code', async () => {
      const outcomes = await interleave(
        db(),
        (tx) =>
          completeFirstRunSetup(
            tx,
            demoSetupInput(code, { email: FIRST }),
            at(MINUTE),
          ),
        (tx) =>
          completeFirstRunSetup(
            tx,
            demoSetupInput(code, { email: SECOND }),
            at(2 * MINUTE),
          ),
      );
      expect(outcomes).toMatchObject([
        { status: 'fulfilled', value: { ok: true } },
        { status: 'fulfilled', value: { ok: false, reason: 'code-invalid' } },
      ]);
      await expectOneSetup();
      // The second one's refusal is audited, and the audit event was kept.
      const failed = (await db().select().from(auditEvent)).filter(
        (event) => event.category === AUTH_AUDIT.setupCheckFailed,
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ details: { purpose: 'setup' } });
    });

    it('lets one of two setups started at the same moment succeed, whichever it is', async () => {
      const results = await Promise.all([
        completeFirstRunSetup(
          db(),
          demoSetupInput(code, { email: FIRST }),
          at(MINUTE),
        ),
        completeFirstRunSetup(
          db(),
          demoSetupInput(code, { email: SECOND }),
          at(MINUTE),
        ),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        { ok: false, reason: 'code-invalid' },
      ]);
      await expectOneSetup();
    });

    it('refuses a code the start-up of a server issues while setup is being completed, so no live code is left behind', async () => {
      const outcomes = await interleave(
        db(),
        (tx) =>
          completeFirstRunSetup(
            tx,
            demoSetupInput(code, { email: FIRST }),
            at(MINUTE),
          ),
        // A server restarting at the same moment. It must wait for the setup, and
        // then find it complete: a code issued after the first administrator
        // exists is one nobody may use.
        (tx) => issueSetupCode(tx, at(2 * MINUTE)),
      );
      expect(outcomes[0]).toMatchObject({
        status: 'fulfilled',
        value: { ok: true },
      });
      expect(outcomes[1]).toMatchObject({
        status: 'rejected',
        reason: { name: 'AuthStateError', reason: 'setup-complete' },
      });
      const live = (await db().select().from(setupCode)).filter(
        (row) => row.usedAt === null && row.revokedAt === null,
      );
      expect(live).toEqual([]);
      await expectOneSetup();
    });
  },
);
