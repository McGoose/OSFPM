import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import {
  changeEvent,
  changeSeq,
  organisation,
  person,
  project,
} from './schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  succeeded,
  testTargets,
} from './test-support.js';
import {
  insertRecord,
  lockOrganisationChanges,
  lockProjectChanges,
  type WriteContext,
} from './write.js';

/**
 * `lockOrganisationChanges`: the organisation's change counter taken first, by a
 * service that must lock a row before it writes a record of the organisation, as
 * `lockProjectChanges` is for a project (CLAUDE.md, Data rules). The overlapping
 * tests need two real sessions, so they run on PostgreSQL and are skipped on
 * PGlite, which has one connection.
 */

const ORIGIN = newId();

const ctx = (): WriteContext => ({
  actor: { type: 'system', id: null },
  originServer: ORIGIN,
  clock: () => new Date(Date.UTC(2026, 0, 1, 12)),
});

let counter = 0;

/** The values of a new organisation: its `organisation_id` is its own `id`. */
function organisationValues() {
  counter += 1;
  const id = newId();
  return {
    id,
    organisationId: id,
    ownerOrgId: id,
    slug: `lock-changes-${counter}`,
    name: 'Demo Pictures',
    country: 'GB',
    defaultLocale: 'en-GB',
    defaultTimezone: 'Europe/London',
    baseCurrency: 'GBP',
    status: 'active' as const,
  };
}

const personValues = (organisationId: string, displayName: string) => ({
  organisationId,
  ownerOrgId: organisationId,
  originServer: ORIGIN,
  displayName,
});

const projectValues = (organisationId: string) => ({
  organisationId,
  ownerOrgId: organisationId,
  originServer: ORIGIN,
  code: 'TLW',
  title: 'The Last Withdrawal',
  format: 'feature' as const,
  status: 'development' as const,
  timezone: 'Europe/London',
  locale: 'en-GB',
  currency: 'GBP',
});

describe.each(testTargets)('lockOrganisationChanges on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
  });
  afterAll(async () => {
    await cleanup();
  });

  const counterOf = (organisationId: string) =>
    database.db
      .select()
      .from(changeSeq)
      .where(
        and(
          eq(changeSeq.organisationId, organisationId),
          isNull(changeSeq.projectId),
        ),
      );

  it('numbers nothing and writes nothing: the counter, the events and the rows stay as they were', async () => {
    const values = organisationValues();
    await database.db.transaction((tx) =>
      insertRecord(tx, organisation, values, ctx()),
    );
    const before = await counterOf(values.id);
    const events = (await database.db.select().from(changeEvent)).length;

    await database.db.transaction((tx) =>
      lockOrganisationChanges(tx, values.id),
    );

    expect(await counterOf(values.id)).toEqual(before);
    expect(before.map((row) => row.lastSeq)).toEqual([1]);
    expect((await database.db.select().from(changeEvent)).length).toBe(events);
  });

  it('takes nothing, and makes no counter, for an organisation that was never written through the helper', async () => {
    const values = organisationValues();
    // A direct insert, as fixtures do: it has no counter row yet.
    await database.db.insert(organisation).values({
      ...values,
      originServer: ORIGIN,
    });
    await database.db.transaction((tx) =>
      lockOrganisationChanges(tx, values.id),
    );
    expect(await counterOf(values.id)).toEqual([]);
  });
});

/** The PostgreSQL target, when `DATABASE_URL` names a server. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/** A promise that is resolved from outside. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Fails with `message` when `work` has not finished after `ms`. */
function within<T>(ms: number, work: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

describe.skipIf(postgres === undefined)(
  'lockOrganisationChanges with overlapping transactions, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let organisationId: string;
    let projectId: string;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
      const values = organisationValues();
      organisationId = values.id;
      await database.db.transaction(async (tx) => {
        await insertRecord(tx, organisation, values, ctx());
        const created = await insertRecord(
          tx,
          project,
          projectValues(organisationId),
          ctx(),
        );
        projectId = created.id;
      });
    });
    afterAll(async () => {
      await cleanup();
    });

    it('waits behind a write of an organisation-level record, which holds the counter until it commits', async () => {
      // `interleave` fails when the waiter finishes while the holder is open.
      const outcomes = await interleave(
        database.db,
        (tx) =>
          insertRecord(tx, person, personValues(organisationId, 'Alex'), ctx()),
        (tx) => lockOrganisationChanges(tx, organisationId),
      );
      expect(succeeded(outcomes)).toBe(2);
    });

    it('makes a write of an organisation-level record wait behind it', async () => {
      const outcomes = await interleave(
        database.db,
        (tx) => lockOrganisationChanges(tx, organisationId),
        (tx) =>
          insertRecord(tx, person, personValues(organisationId, 'Sam'), ctx()),
      );
      expect(succeeded(outcomes)).toBe(2);
    });

    it('queues two callers one after the other', async () => {
      const outcomes = await interleave(
        database.db,
        (tx) => lockOrganisationChanges(tx, organisationId),
        (tx) => lockOrganisationChanges(tx, organisationId),
      );
      expect(succeeded(outcomes)).toBe(2);
    });

    it('is not the counter of a project: it does not wait for a project’s writers, and they do not wait for it', async () => {
      const held = deferred();
      const release = deferred();
      const open = database.db.transaction(async (tx) => {
        await lockProjectChanges(tx, organisationId, projectId);
        held.resolve();
        await release.promise;
      });
      try {
        await Promise.race([held.promise, open]);
        await within(
          5_000,
          database.db.transaction((tx) =>
            lockOrganisationChanges(tx, organisationId),
          ),
          'The organisation counter waited for a project counter',
        );
      } finally {
        release.resolve();
      }
      await open;

      const heldByOrganisation = deferred();
      const releaseOrganisation = deferred();
      const openOrganisation = database.db.transaction(async (tx) => {
        await lockOrganisationChanges(tx, organisationId);
        heldByOrganisation.resolve();
        await releaseOrganisation.promise;
      });
      try {
        await Promise.race([heldByOrganisation.promise, openOrganisation]);
        await within(
          5_000,
          database.db.transaction((tx) =>
            lockProjectChanges(tx, organisationId, projectId),
          ),
          'A project counter waited for the organisation counter',
        );
      } finally {
        releaseOrganisation.resolve();
      }
      await openOrganisation;
    });

    it('does not wait for the counter of another organisation', async () => {
      const other = organisationValues();
      await database.db.transaction((tx) =>
        insertRecord(tx, organisation, other, ctx()),
      );
      const held = deferred();
      const release = deferred();
      const open = database.db.transaction(async (tx) => {
        await lockOrganisationChanges(tx, other.id);
        held.resolve();
        await release.promise;
      });
      try {
        await Promise.race([held.promise, open]);
        await within(
          5_000,
          database.db.transaction((tx) =>
            lockOrganisationChanges(tx, organisationId),
          ),
          'An organisation counter waited for another organisation’s',
        );
      } finally {
        release.resolve();
      }
      await open;
    });
  },
);
