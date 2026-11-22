import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import {
  changeEvent,
  changeSeq,
  organisation,
  person,
} from './schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from './test-support.js';
import { insertRecord, updateRecord, type WriteContext } from './write.js';

/**
 * The write helper creating an organisation: the fourth kind of table it serves,
 * after organisation-level records, project-level records and the project table
 * itself (CLAUDE.md, Data rules). An organisation is its own tenant, and its
 * change counter references it, so the counter can only be taken once the row
 * exists, as a new project's is.
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
    slug: `write-organisation-${counter}`,
    name: 'Demo Pictures',
    country: 'GB',
    defaultLocale: 'en-GB',
    defaultTimezone: 'Europe/London',
    baseCurrency: 'GBP',
    status: 'active' as const,
  };
}

/** The tables whose inserts the order test notes: the organisation, an ordinary record, the counter and the event. */
const NOTED_TABLES = [
  'organisation',
  'person',
  'change_seq',
  'change_event',
] as const;

const personValues = (organisationId: string, displayName: string) => ({
  organisationId,
  ownerOrgId: organisationId,
  originServer: ORIGIN,
  displayName,
});

describe.each(testTargets)(
  'write helper creating organisations on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
    });
    afterAll(async () => {
      await cleanup();
    });

    const eventsOf = (organisationId: string) =>
      database.db
        .select()
        .from(changeEvent)
        .where(eq(changeEvent.organisationId, organisationId))
        .orderBy(asc(changeEvent.seq));
    const countersOf = (organisationId: string) =>
      database.db
        .select()
        .from(changeSeq)
        .where(eq(changeSeq.organisationId, organisationId));

    it('creates the organisation, and gives it its own change_event with seq 1 in its own sequence', async () => {
      const values = organisationValues();
      const created = await database.db.transaction((tx) =>
        insertRecord(tx, organisation, values, ctx()),
      );
      expect(created).toMatchObject({
        id: values.id,
        organisationId: values.id,
        version: 1,
        originServer: ORIGIN,
      });
      const events = await eventsOf(values.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        organisationId: values.id,
        projectId: null,
        entityType: 'organisation',
        entityId: values.id,
        action: 'create',
        seq: 1,
        entityVersion: 1,
        actorType: 'system',
      });
      // The counter is the organisation's own, not a project's.
      const counters = await countersOf(values.id);
      expect(counters).toHaveLength(1);
      expect(counters[0]).toMatchObject({ projectId: null, lastSeq: 1 });
    });

    it('logs the whole row of the new organisation in the event', async () => {
      const values = organisationValues();
      await database.db.transaction((tx) =>
        insertRecord(tx, organisation, values, ctx()),
      );
      const [event] = await eventsOf(values.id);
      expect(event!.after).toMatchObject({
        id: values.id,
        organisation_id: values.id,
        slug: values.slug,
        name: 'Demo Pictures',
        country: 'GB',
        base_currency: 'GBP',
        status: 'active',
      });
    });

    it('numbers what is written in the organisation afterwards in the same sequence', async () => {
      const values = organisationValues();
      await database.db.transaction((tx) =>
        insertRecord(tx, organisation, values, ctx()),
      );
      const alex = await database.db.transaction((tx) =>
        insertRecord(tx, person, personValues(values.id, 'Alex Demo'), ctx()),
      );
      await database.db.transaction((tx) =>
        updateRecord(
          tx,
          organisation,
          values.id,
          1,
          { name: 'Demo Pictures Ltd' },
          ctx(),
        ),
      );
      const events = await eventsOf(values.id);
      expect(
        events.map((e) => [
          e.entityType,
          e.entityId,
          e.action,
          e.projectId,
          e.seq,
        ]),
      ).toEqual([
        ['organisation', values.id, 'create', null, 1],
        ['person', alex.id, 'create', null, 2],
        ['organisation', values.id, 'update', null, 3],
      ]);
      expect((await countersOf(values.id))[0]!.lastSeq).toBe(3);
    });

    it('leaves no organisation, counter or event when the transaction fails afterwards', async () => {
      const values = organisationValues();
      await expect(
        database.db.transaction(async (tx) => {
          await insertRecord(tx, organisation, values, ctx());
          throw new Error('a later step failed');
        }),
      ).rejects.toThrow('a later step failed');
      expect(
        await database.db
          .select()
          .from(organisation)
          .where(eq(organisation.id, values.id)),
      ).toEqual([]);
      expect(await countersOf(values.id)).toEqual([]);
      expect(await eventsOf(values.id)).toEqual([]);
    });

    it('refuses a row that is not its own tenant through the row, and takes no counter first', async () => {
      const values = organisationValues();
      const stranger = newId();
      // The row's own CHECK refuses it. Were the counter taken first, the
      // failure would be `change_seq_organisation_fk` and a counter might stay.
      const failure = await failureOf(() =>
        database.db.transaction((tx) =>
          insertRecord(
            tx,
            organisation,
            { ...values, organisationId: stranger },
            ctx(),
          ),
        ),
      );
      expect(failure).toEqual({
        code: SQLSTATE.checkViolation,
        constraint: 'organisation_is_own_tenant_check',
      });
      expect(await countersOf(values.id)).toEqual([]);
      expect(await countersOf(stranger)).toEqual([]);
    });

    describe('the order of the writes', () => {
      // Lock order (CLAUDE.md, Data rules): a writer takes the change counter
      // before any row lock. A new organisation cannot have its counter first,
      // because the counter references it, so the row comes first. Nothing else
      // is taken before it: the organisation has no project resolver, so there
      // is no query, and no other writer can see, let alone reference, an
      // organisation that is not committed, so none can wait on this row or on
      // the counter that follows it. This pins the order the reasoning rests on.
      beforeAll(async () => {
        await database.db.execute(
          sql.raw(`create table osfpm_test_order (
                     n serial primary key,
                     step text not null)`),
        );
        await database.db.execute(
          sql.raw(`create function osfpm_test_note() returns trigger
                   language plpgsql as $$
                   begin
                     insert into osfpm_test_order (step) values (tg_table_name);
                     return new;
                   end $$`),
        );
        for (const table of NOTED_TABLES) {
          await database.db.execute(
            sql.raw(`create trigger osfpm_test_note_${table}
                     before insert on ${table}
                     for each row execute function osfpm_test_note()`),
          );
        }
      });
      afterAll(async () => {
        for (const table of NOTED_TABLES) {
          await database.db.execute(
            sql.raw(`drop trigger osfpm_test_note_${table} on ${table}`),
          );
        }
        await database.db.execute(sql.raw('drop function osfpm_test_note()'));
        await database.db.execute(sql.raw('drop table osfpm_test_order'));
      });

      it('inserts the organisation row, then takes its counter, then logs its event', async () => {
        await database.db.execute(sql.raw('delete from osfpm_test_order'));
        await database.db.transaction((tx) =>
          insertRecord(tx, organisation, organisationValues(), ctx()),
        );
        const steps = (await database.db.execute(
          sql.raw('select step from osfpm_test_order order by n'),
        )) as { rows: { step: string }[] };
        expect(steps.rows.map((row) => row.step)).toEqual([
          'organisation',
          'change_seq',
          'change_event',
        ]);
      });

      it('still takes the counter before the row for every record of an organisation that exists', async () => {
        const values = organisationValues();
        await database.db.transaction((tx) =>
          insertRecord(tx, organisation, values, ctx()),
        );
        await database.db.execute(sql.raw('delete from osfpm_test_order'));
        await database.db.transaction((tx) =>
          insertRecord(
            tx,
            person,
            personValues(values.id, 'Sam Example'),
            ctx(),
          ),
        );
        const steps = (await database.db.execute(
          sql.raw('select step from osfpm_test_order order by n'),
        )) as { rows: { step: string }[] };
        expect(steps.rows.map((row) => row.step)).toEqual([
          'change_seq',
          'person',
          'change_event',
        ]);
      });
    });
  },
);

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot overlap two transactions. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/** A promise that is settled from outside. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Rejects with `message` unless `work` settles within `ms`. */
function within<T>(ms: number, work: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Organisations created at the same time, on two or more real connections. Each
 * has its own sequence, and creating one takes nothing another holds: the new
 * row is invisible to everyone else, and its counter row is its own. The
 * overlapping tests hold one transaction open while another runs to its end, so
 * a lock they shared would hang the second until the limit and fail it with
 * what it waited for. Only a server with real concurrent sessions can show that,
 * so these run on PostgreSQL and are skipped on PGlite.
 */
describe.skipIf(postgres === undefined)(
  'creating organisations at the same time, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
    });
    afterAll(async () => {
      await cleanup();
    });

    const sequenceOf = async (organisationId: string) => ({
      counters: await database.db
        .select()
        .from(changeSeq)
        .where(
          and(
            eq(changeSeq.organisationId, organisationId),
            isNull(changeSeq.projectId),
          ),
        ),
      events: await database.db
        .select()
        .from(changeEvent)
        .where(eq(changeEvent.organisationId, organisationId))
        .orderBy(asc(changeEvent.seq)),
    });

    it('gives each of several organisations created at once seq 1 in its own sequence', async () => {
      const all = Array.from({ length: 6 }, () => organisationValues());
      await Promise.all(
        all.map((values) =>
          database.db.transaction((tx) =>
            insertRecord(tx, organisation, values, ctx()),
          ),
        ),
      );
      for (const values of all) {
        const { counters, events } = await sequenceOf(values.id);
        expect(
          counters.map((c) => c.lastSeq),
          values.slug,
        ).toEqual([1]);
        expect(
          events.map((e) => [e.entityType, e.entityId, e.seq]),
          values.slug,
        ).toEqual([['organisation', values.id, 1]]);
      }
    });

    it('lets a second organisation be created and committed while the first is still open, and both are seq 1', async () => {
      const first = organisationValues();
      const second = organisationValues();
      const written = deferred();
      const release = deferred();
      const open = database.db.transaction(async (tx) => {
        const row = await insertRecord(tx, organisation, first, ctx());
        written.resolve();
        await release.promise;
        return row;
      });
      try {
        // A failure of the first before it is written ends the test here.
        await Promise.race([written.promise, open]);
        await within(
          5_000,
          database.db.transaction((tx) =>
            insertRecord(tx, organisation, second, ctx()),
          ),
          'The second organisation waited for the first',
        );
      } finally {
        release.resolve();
      }
      await open;
      for (const values of [first, second]) {
        const { counters, events } = await sequenceOf(values.id);
        expect(
          counters.map((c) => c.lastSeq),
          values.slug,
        ).toEqual([1]);
        expect(
          events.map((e) => e.seq),
          values.slug,
        ).toEqual([1]);
      }
    });

    it('does not wait for another organisation that holds its own counter, and starts at 1 whatever that one is at', async () => {
      const existing = organisationValues();
      await database.db.transaction((tx) =>
        insertRecord(tx, organisation, existing, ctx()),
      );
      const created = organisationValues();
      const written = deferred();
      const release = deferred();
      // A write in the existing organisation: it takes that organisation's
      // counter and keeps it until the transaction ends.
      const open = database.db.transaction(async (tx) => {
        const row = await insertRecord(
          tx,
          person,
          personValues(existing.id, 'Alex Demo'),
          ctx(),
        );
        written.resolve();
        await release.promise;
        return row;
      });
      try {
        await Promise.race([written.promise, open]);
        await within(
          5_000,
          database.db.transaction((tx) =>
            insertRecord(tx, organisation, created, ctx()),
          ),
          "Creating an organisation waited for another organisation's counter",
        );
      } finally {
        release.resolve();
      }
      await open;
      expect((await sequenceOf(created.id)).events.map((e) => e.seq)).toEqual([
        1,
      ]);
      expect((await sequenceOf(existing.id)).events.map((e) => e.seq)).toEqual([
        1, 2,
      ]);
    });
  },
);
