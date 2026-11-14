import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '../projects/create.js';
import type { Database } from './client.js';
import { newId } from './ids.js';
import {
  changeEvent,
  changeSeq,
  organisation,
  person,
  project,
  unit,
} from './schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from './test-support.js';
import { insertRecord, type WriteContext } from './write.js';

const ORIGIN = newId();

const ctx = (): WriteContext => ({
  actor: { type: 'system', id: null },
  originServer: ORIGIN,
  clock: () => new Date(Date.UTC(2026, 0, 1, 12)),
});

const base = (organisationId: string) => ({
  organisationId,
  ownerOrgId: organisationId,
  originServer: ORIGIN,
});

const projectValues = (organisationId: string, code = 'TLW') => ({
  ...base(organisationId),
  code,
  title: 'The Last Withdrawal',
  format: 'feature' as const,
  status: 'development' as const,
  timezone: 'Europe/London',
  locale: 'en-GB',
  currency: 'GBP',
});

describe.each(testTargets)(
  'write helper creating projects on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let counter = 0;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
    });
    afterAll(async () => {
      await cleanup();
    });

    /** A new, empty organisation. */
    async function newOrganisation(): Promise<string> {
      counter += 1;
      const id = newId();
      await database.db.insert(organisation).values({
        id,
        organisationId: id,
        ownerOrgId: id,
        originServer: ORIGIN,
        slug: `write-project-org-${counter}`,
        name: 'Demo Pictures',
        country: 'GB',
        defaultLocale: 'en-GB',
        defaultTimezone: 'Europe/London',
        baseCurrency: 'GBP',
        status: 'active',
      });
      return id;
    }

    /** Makes every insert into `unit` fail, to test what is left behind. */
    async function refuseUnits() {
      await database.db.execute(
        sql.raw(`create function osfpm_test_refuse_unit() returns trigger
                 language plpgsql as $$
                 begin
                   raise exception 'unit refused' using errcode = 'P0001';
                 end $$`),
      );
      await database.db.execute(
        sql.raw(`create trigger osfpm_test_refuse_unit
                 before insert on unit
                 for each row execute function osfpm_test_refuse_unit()`),
      );
    }
    async function allowUnits() {
      await database.db.execute(
        sql.raw('drop trigger osfpm_test_refuse_unit on unit'),
      );
      await database.db.execute(
        sql.raw('drop function osfpm_test_refuse_unit()'),
      );
    }

    const eventsOf = (organisationId: string, projectId: string) =>
      database.db
        .select()
        .from(changeEvent)
        .where(
          and(
            eq(changeEvent.organisationId, organisationId),
            eq(changeEvent.projectId, projectId),
          ),
        )
        .orderBy(asc(changeEvent.seq));

    it('gives a new project its own change_event with seq 1', async () => {
      const organisationId = await newOrganisation();
      const created = await database.db.transaction((tx) =>
        insertRecord(tx, project, projectValues(organisationId), ctx()),
      );
      const events = await eventsOf(organisationId, created.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        entityType: 'project',
        entityId: created.id,
        action: 'create',
        seq: 1,
      });
      const counters = await database.db
        .select()
        .from(changeSeq)
        .where(eq(changeSeq.projectId, created.id));
      expect(counters).toHaveLength(1);
      expect(counters[0]!.lastSeq).toBe(1);
    });

    it('gives the project seq 1 and its main unit seq 2', async () => {
      const organisationId = await newOrganisation();
      const created = await database.db.transaction((tx) =>
        createProject(tx, ctx(), projectValues(organisationId)),
      );
      const events = await eventsOf(organisationId, created.project.id);
      expect(
        events.map((e) => [e.entityType, e.entityId, e.action, e.seq]),
      ).toEqual([
        ['project', created.project.id, 'create', 1],
        ['unit', created.mainUnit.id, 'create', 2],
      ]);
    });

    describe('when the main unit cannot be created', () => {
      beforeAll(refuseUnits);
      afterAll(allowUnits);

      it('rolls back the project row, its change_seq row and its events', async () => {
        const organisationId = await newOrganisation();
        const failure = await failureOf(() =>
          database.db.transaction((tx) =>
            createProject(tx, ctx(), projectValues(organisationId)),
          ),
        );
        // The unit insert is what failed, so it is not a project-level refusal.
        expect(failure.code).toBe('P0001');

        expect(
          await database.db
            .select()
            .from(project)
            .where(eq(project.organisationId, organisationId)),
        ).toEqual([]);
        expect(
          await database.db
            .select()
            .from(unit)
            .where(eq(unit.organisationId, organisationId)),
        ).toEqual([]);
        expect(
          await database.db
            .select()
            .from(changeSeq)
            .where(eq(changeSeq.organisationId, organisationId)),
        ).toEqual([]);
        expect(
          await database.db
            .select()
            .from(changeEvent)
            .where(eq(changeEvent.organisationId, organisationId)),
        ).toEqual([]);
      });
    });

    describe('when the main unit cannot be created and the caller commits', () => {
      beforeAll(refuseUnits);
      afterAll(allowUnits);

      it('leaves no project, unit, change_seq row or change event', async () => {
        const organisationId = await newOrganisation();
        let caught: unknown;
        await database.db.transaction(async (tx) => {
          try {
            await createProject(tx, ctx(), projectValues(organisationId));
          } catch (error) {
            caught = error;
          }
          // The caller carries on and commits.
        });
        expect(caught).toMatchObject({ code: 'P0001' });

        expect(
          await database.db
            .select()
            .from(project)
            .where(eq(project.organisationId, organisationId)),
        ).toEqual([]);
        expect(
          await database.db
            .select()
            .from(unit)
            .where(eq(unit.organisationId, organisationId)),
        ).toEqual([]);
        expect(
          await database.db
            .select()
            .from(changeSeq)
            .where(eq(changeSeq.organisationId, organisationId)),
        ).toEqual([]);
        expect(
          await database.db
            .select()
            .from(changeEvent)
            .where(eq(changeEvent.organisationId, organisationId)),
        ).toEqual([]);
      });
    });

    describe('every other table keeps its order: seq before row', () => {
      // With the counter first, a row for a project that does not exist is
      // refused by `change_seq_project_fk`. With the row first it would be
      // refused by the row's own foreign key instead.
      it('refuses a project-scoped row of a missing project through the counter', async () => {
        const organisationId = await newOrganisation();
        const failure = await failureOf(() =>
          database.db.transaction((tx) =>
            insertRecord(
              tx,
              unit,
              {
                ...base(organisationId),
                projectId: newId(),
                key: 'main',
                name: 'Main unit',
                kind: 'main',
              },
              ctx(),
            ),
          ),
        );
        expect(failure).toEqual({
          code: SQLSTATE.foreignKeyViolation,
          constraint: 'change_seq_project_fk',
        });
      });

      it('still takes organisation-level seq numbers in order', async () => {
        const organisationId = await newOrganisation();
        const first = await database.db.transaction((tx) =>
          insertRecord(
            tx,
            person,
            { ...base(organisationId), displayName: 'Alex Demo' },
            ctx(),
          ),
        );
        const second = await database.db.transaction((tx) =>
          insertRecord(
            tx,
            person,
            { ...base(organisationId), displayName: 'Sam Example' },
            ctx(),
          ),
        );
        const events = await database.db
          .select()
          .from(changeEvent)
          .where(eq(changeEvent.organisationId, organisationId))
          .orderBy(asc(changeEvent.seq));
        expect(events.map((e) => [e.entityId, e.projectId, e.seq])).toEqual([
          [first.id, null, 1],
          [second.id, null, 2],
        ]);
      });
    });
  },
);
