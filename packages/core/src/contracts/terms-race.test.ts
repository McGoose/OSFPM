import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncPermissions } from '../access/permission-sync.js';
import { base } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  changeEvent,
  changeSeq,
  contract,
  contractTerms,
} from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  succeeded,
  testTargets,
} from '../db/test-support.js';
import { VersionConflictError } from '../db/write.js';
import { CONTRACT_PERMISSIONS } from './permissions.js';
import {
  ContractInputError,
  ContractTermsConflictError,
  removeContractTerms,
  setContractTerms,
  updateContract,
} from './service.js';
import {
  at,
  seedContract,
  seedTermsWorld,
  type TermsWorld,
} from './test-support.js';

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/** The reason a settled outcome was rejected with; fails the test when it was not rejected. */
function reasonOf(outcome: PromiseSettledResult<unknown> | undefined): unknown {
  if (outcome?.status !== 'rejected') {
    throw new Error('Expected the call to be rejected');
  }
  return outcome.reason;
}

/**
 * Writes of one contract's terms on two real connections, in a fixed order: the
 * first stays open until the second is waiting for a lock. Only a server with
 * concurrent sessions can show what the second then does, so the tests run on
 * PostgreSQL and are skipped on PGlite.
 *
 * Every race runs twice: in a project whose change counter row exists, which is how
 * a project made through the write helper starts, and in one without it, as the
 * fixtures make it. The second takes the counter after the first has written, so a
 * writer waits on a different lock, and must still end the same way.
 */
describe.skipIf(postgres === undefined)(
  'terms written at the same moment on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    const db = () => database.db;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
      await syncPermissions(db(), CONTRACT_PERMISSIONS);
    });
    afterAll(async () => {
      await cleanup();
    });

    /** Whether the project has a row in `change_seq`, the counter every writer in it queues on. */
    const hasChangeCounter = async (w: TermsWorld) =>
      (
        await db()
          .select({ lastSeq: changeSeq.lastSeq })
          .from(changeSeq)
          .where(
            and(
              eq(changeSeq.organisationId, w.organisationId),
              eq(changeSeq.projectId, w.projectId),
            ),
          )
      ).length === 1;

    /**
     * A project with a crew contract and the users of the terms tests. With
     * `warm` the contract is made through the service, which gives the project its
     * change counter row; without it the contract is inserted directly, as the
     * fixtures do, and the project has none yet. The scene is checked for the
     * counter it is meant to have, so a test cannot quietly run the other one.
     */
    async function scene(warm: boolean) {
      const w = await seedTermsWorld(database);
      let contractId: string;
      let version: number;
      if (warm) {
        const made = await seedContract(database, w);
        contractId = made.id;
        version = made.version;
      } else {
        const [row] = await db()
          .insert(contract)
          .values({
            ...base(w.organisationId),
            projectId: w.projectId,
            kind: 'crew-contract',
            title: 'Camera operator agreement',
            status: 'draft',
          })
          .returning({ id: contract.id, version: contract.version });
        contractId = row!.id;
        version = row!.version;
      }
      expect(
        await hasChangeCounter(w),
        'the project’s change counter row',
      ).toBe(warm);
      return { w, contractId, contractVersion: version };
    }

    const termsRows = (contractId: string) =>
      db()
        .select()
        .from(contractTerms)
        .where(eq(contractTerms.contractId, contractId));

    describe.each([
      { name: 'a project with a change counter', warm: true },
      { name: 'a project with no change counter yet', warm: false },
    ])('in $name', ({ warm }) => {
      it('makes the terms once when two first-time sets overlap, and the second gets the typed conflict, not a database error', async () => {
        const { w, contractId } = await scene(warm);
        const outcomes = await interleave(
          db(),
          (tx) =>
            setContractTerms(tx, at(w.manager), contractId, {
              paymentTermsDays: 30,
            }),
          (tx) =>
            setContractTerms(tx, at(w.assistant), contractId, {
              paymentTermsDays: 45,
            }),
        );
        expect(succeeded(outcomes)).toBe(1);
        expect(outcomes[0].status).toBe('fulfilled');
        expect(reasonOf(outcomes[1])).toBeInstanceOf(
          ContractTermsConflictError,
        );
        const rows = await termsRows(contractId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ paymentTermsDays: 30, version: 1 });
        const events = await db()
          .select()
          .from(changeEvent)
          .where(
            and(
              eq(changeEvent.organisationId, w.organisationId),
              eq(changeEvent.entityType, 'contract_terms'),
            ),
          );
        expect(events).toHaveLength(1);
      });

      it('never answers with a database error when many first-time sets start together', async () => {
        const { w, contractId } = await scene(warm);
        const sets = [30, 45, 60, 90].map((days) =>
          db().transaction((tx) =>
            setContractTerms(tx, at(w.manager), contractId, {
              paymentTermsDays: days,
            }),
          ),
        );
        const outcomes = await Promise.allSettled(sets);
        // A set that read the terms before another made them is the typed conflict;
        // one that read them after changes them, or is refused for a stale version.
        // Nothing else is allowed, and above all no database error.
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            expect(
              outcome.reason instanceof ContractTermsConflictError ||
                outcome.reason instanceof VersionConflictError,
              String(outcome.reason),
            ).toBe(true);
          }
        }
        expect(succeeded(outcomes)).toBeGreaterThanOrEqual(1);
        expect(await termsRows(contractId)).toHaveLength(1);
      });

      it('refuses terms for a contract whose kind a change has just turned into one that has none', async () => {
        const { w, contractId, contractVersion } = await scene(warm);
        // The set read the kind as `crew-contract` before the change landed. It waits
        // for the change, reads the contract again under its lock, and sees the new kind.
        const outcomes = await interleave(
          db(),
          (tx) =>
            updateContract(tx, at(w.manager), contractId, contractVersion, {
              kind: 'location-agreement',
            }),
          (tx) =>
            setContractTerms(tx, at(w.manager), contractId, {
              paymentTermsDays: 30,
            }),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(reasonOf(outcomes[1])).toBeInstanceOf(ContractInputError);
        expect(await termsRows(contractId)).toEqual([]);
      });
    });

    // These write the terms first, so the project has its change counter by the time
    // they race, whatever the scene started with.
    describe('on terms that already exist', () => {
      it('refuses a change made on terms that another change has just replaced', async () => {
        const { w, contractId } = await scene(true);
        await setContractTerms(db(), at(w.manager), contractId, {
          paymentTermsDays: 30,
        });
        const outcomes = await interleave(
          db(),
          (tx) =>
            setContractTerms(tx, at(w.manager), contractId, {
              paymentTermsDays: 45,
            }),
          (tx) =>
            setContractTerms(tx, at(w.assistant), contractId, {
              pensionApplies: true,
            }),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(reasonOf(outcomes[1])).toBeInstanceOf(VersionConflictError);
        const [row] = await termsRows(contractId);
        expect(row).toMatchObject({
          paymentTermsDays: 45,
          pensionApplies: null,
          version: 2,
        });
      });

      it('refuses a change made on terms that a removal has just removed', async () => {
        const { w, contractId } = await scene(true);
        const first = await setContractTerms(db(), at(w.manager), contractId, {
          paymentTermsDays: 30,
        });
        const outcomes = await interleave(
          db(),
          (tx) =>
            removeContractTerms(tx, at(w.manager), contractId, first.version),
          (tx) =>
            setContractTerms(tx, at(w.assistant), contractId, {
              paymentTermsDays: 45,
            }),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(reasonOf(outcomes[1])).toBeInstanceOf(VersionConflictError);
        const [row] = await termsRows(contractId);
        expect(row!.deletedAt).not.toBeNull();
        expect(row!.paymentTermsDays).toBe(30);
      });
    });
  },
);
