import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { text, uuid } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPEND_ONLY_SQLSTATE, appendOnlyMigrationSql } from './append-only.js';
import type { Database } from './client.js';
import { standardColumns, tenantTable } from './columns.js';
import { newId } from './ids.js';
import { MIGRATIONS_FOLDER } from './migrate.js';
import { registerProjectResolver } from './project-resolver.js';
import {
  auditEvent,
  changeEvent,
  changeSeq,
  organisation,
  permission,
  project,
  projectMembership,
  projectMembershipRole,
  role,
  rolePermission,
  user,
} from './schema/index.js';
import { markSensitive, sensitiveColumns } from './sensitive.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from './test-support.js';
import {
  insertRecord,
  RecordNotFoundError,
  RecordWriteError,
  recordAudit,
  restoreRecord,
  softDeleteRecord,
  updateRecord,
  VersionConflictError,
  type WriteContext,
} from './write.js';

/** A stand-in tenant table. No real table has sensitive columns yet. */
const dummyRecord = tenantTable('dummy_record', () => organisation.id, {
  ...standardColumns(() => user.id),
  projectId: uuid('project_id'),
  title: text('title').notNull(),
  secretNote: text('secret_note'),
});
markSensitive(dummyRecord, ['secretNote']);

const SECRET = 'the-sensitive-value-1f9e';
const OTHER_SECRET = 'another-sensitive-value-7c2d';

const CREATE_DUMMY_TABLE = sql`
  create table dummy_record (
    id uuid primary key,
    organisation_id uuid not null references organisation (id),
    owner_org_id uuid not null,
    origin_server uuid not null,
    visibility text not null default 'project',
    version integer not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    created_by uuid references "user" (id),
    updated_by uuid references "user" (id),
    deleted_at timestamptz,
    deleted_by uuid references "user" (id),
    retention_class text,
    project_id uuid,
    title text not null,
    secret_note text
  )`;

type Row = Record<string, unknown>;

async function rows(database: Database, query: ReturnType<typeof sql>) {
  const result = (await database.db.execute(query)) as { rows: Row[] };
  return result.rows;
}

let counter = 0;
async function seedTenant(database: Database) {
  counter += 1;
  const organisationId = newId();
  await database.db.insert(organisation).values({
    id: organisationId,
    organisationId,
    ownerOrgId: organisationId,
    originServer: newId(),
    slug: `log-demo-org-${counter}`,
    name: 'Demo Pictures',
    country: 'GB',
    defaultLocale: 'en-GB',
    defaultTimezone: 'Europe/London',
    baseCurrency: 'GBP',
    status: 'active',
  });
  const projectId = newId();
  await database.db.insert(project).values({
    id: projectId,
    organisationId,
    ownerOrgId: organisationId,
    originServer: newId(),
    code: 'TLW',
    title: 'The Last Withdrawal',
    format: 'feature',
    status: 'development',
    timezone: 'Europe/London',
    locale: 'en-GB',
    currency: 'GBP',
  });
  return { organisationId, projectId };
}

async function seedUser(database: Database) {
  counter += 1;
  const id = newId();
  await database.db.insert(user).values({
    id,
    originServer: newId(),
    email: `log.user${counter}@example.test`,
    displayName: 'Demo User',
    locale: 'en-GB',
    timezone: 'Europe/London',
    status: 'active',
  });
  return id;
}

function dummyValues(
  organisationId: string,
  projectId: string | null,
  overrides: Partial<typeof dummyRecord.$inferInsert> = {},
) {
  return {
    organisationId,
    ownerOrgId: organisationId,
    projectId,
    title: 'Call sheet',
    ...overrides,
  };
}

const ORIGIN = newId();

function contextFor(
  actorId: string | null,
  overrides: Partial<WriteContext> = {},
): WriteContext {
  let tick = 0;
  return {
    actor: { type: actorId ? 'user' : 'system', id: actorId },
    requestId: 'req-1',
    originServer: ORIGIN,
    clock: () => new Date(Date.UTC(2026, 0, 1, 12, 0, tick++)),
    ...overrides,
  };
}

async function eventsFor(database: Database, entityId: string) {
  return database.db
    .select()
    .from(changeEvent)
    .where(sql`${changeEvent.entityId} = ${entityId}`)
    .orderBy(changeEvent.seq);
}

async function seqsFor(
  database: Database,
  organisationId: string,
  projectId: string | null,
) {
  const found = await database.db
    .select({ seq: changeEvent.seq })
    .from(changeEvent)
    .where(
      projectId === null
        ? sql`${changeEvent.organisationId} = ${organisationId} and ${changeEvent.projectId} is null`
        : sql`${changeEvent.organisationId} = ${organisationId} and ${changeEvent.projectId} = ${projectId}`,
    )
    .orderBy(changeEvent.seq);
  return found.map((r) => r.seq);
}

describe.each(testTargets)('change log and write helper on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let userId: string;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    await database.db.execute(CREATE_DUMMY_TABLE);
    userId = await seedUser(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  describe('write helper', () => {
    it('logs exactly one change_event for each insert, update, soft delete and restore', async () => {
      const t = await seedTenant(database);
      const ctx = contextFor(userId);
      const created = await database.db.transaction((tx) =>
        insertRecord(
          tx,
          dummyRecord,
          dummyValues(t.organisationId, t.projectId),
          ctx,
        ),
      );
      expect(await eventsFor(database, created.id)).toHaveLength(1);

      const updated = await database.db.transaction((tx) =>
        updateRecord(tx, dummyRecord, created.id, 1, { title: 'Revised' }, ctx),
      );
      expect(await eventsFor(database, created.id)).toHaveLength(2);

      const deleted = await database.db.transaction((tx) =>
        softDeleteRecord(tx, dummyRecord, created.id, updated.version, ctx),
      );
      expect(await eventsFor(database, created.id)).toHaveLength(3);

      const restored = await database.db.transaction((tx) =>
        restoreRecord(tx, dummyRecord, created.id, deleted.version, ctx),
      );
      const events = await eventsFor(database, created.id);
      expect(events.map((e) => [e.action, e.seq, e.entityVersion])).toEqual([
        ['create', 1, 1],
        ['update', 2, 2],
        ['delete', 3, 3],
        ['restore', 4, 4],
      ]);
      expect(restored.version).toBe(4);
    });

    it('records who, when, where and which request on each event', async () => {
      const t = await seedTenant(database);
      const ctx = contextFor(userId);
      const created = await database.db.transaction((tx) =>
        insertRecord(
          tx,
          dummyRecord,
          dummyValues(t.organisationId, t.projectId),
          ctx,
        ),
      );
      const [event] = await eventsFor(database, created.id);
      expect(event).toMatchObject({
        organisationId: t.organisationId,
        projectId: t.projectId,
        entityType: 'dummy_record',
        entityId: created.id,
        actorType: 'user',
        actorId: userId,
        requestId: 'req-1',
        originServer: ORIGIN,
      });
      expect(event!.occurredAt).toBeInstanceOf(Date);
      expect(created.originServer).toBe(ORIGIN);
    });

    it('sets version and the updated and deleted columns from the context', async () => {
      const t = await seedTenant(database);
      const ctx = contextFor(userId);
      const created = await database.db.transaction((tx) =>
        insertRecord(
          tx,
          dummyRecord,
          dummyValues(t.organisationId, t.projectId),
          ctx,
        ),
      );
      expect(created).toMatchObject({
        version: 1,
        createdBy: userId,
        updatedBy: userId,
        deletedAt: null,
      });
      const deleted = await database.db.transaction((tx) =>
        softDeleteRecord(tx, dummyRecord, created.id, 1, ctx),
      );
      expect(deleted.version).toBe(2);
      expect(deleted.deletedBy).toBe(userId);
      expect(deleted.deletedAt).toBeInstanceOf(Date);
      expect(deleted.updatedAt.getTime()).toBeGreaterThan(
        created.updatedAt.getTime(),
      );
      const restored = await database.db.transaction((tx) =>
        restoreRecord(tx, dummyRecord, created.id, 2, ctx),
      );
      expect(restored).toMatchObject({
        version: 3,
        deletedAt: null,
        deletedBy: null,
      });
    });

    it('leaves user columns empty for a non-user actor', async () => {
      const t = await seedTenant(database);
      const ctx = contextFor(null);
      const created = await database.db.transaction((tx) =>
        insertRecord(
          tx,
          dummyRecord,
          dummyValues(t.organisationId, t.projectId),
          ctx,
        ),
      );
      expect(created.createdBy).toBeNull();
      expect(created.updatedBy).toBeNull();
      const [event] = await eventsFor(database, created.id);
      expect(event).toMatchObject({ actorType: 'system', actorId: null });
    });

    it('writes the row and its event in the same transaction: a rollback leaves neither', async () => {
      const t = await seedTenant(database);
      const ctx = contextFor(userId);
      const id = newId();
      await expect(
        database.db.transaction(async (tx) => {
          await insertRecord(
            tx,
            dummyRecord,
            dummyValues(t.organisationId, t.projectId, { id }),
            ctx,
          );
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await eventsFor(database, id)).toHaveLength(0);
      expect(
        await rows(database, sql`select id from dummy_record where id = ${id}`),
      ).toHaveLength(0);
      expect(
        await database.db
          .select()
          .from(changeSeq)
          .where(sql`${changeSeq.projectId} = ${t.projectId}`),
      ).toHaveLength(0);
    });

    it('gives the seq back when a write is rolled back', async () => {
      const t = await seedTenant(database);
      const ctx = contextFor(userId);
      await database.db.transaction((tx) =>
        insertRecord(
          tx,
          dummyRecord,
          dummyValues(t.organisationId, t.projectId),
          ctx,
        ),
      );
      await expect(
        database.db.transaction(async (tx) => {
          await insertRecord(
            tx,
            dummyRecord,
            dummyValues(t.organisationId, t.projectId),
            ctx,
          );
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      await database.db.transaction((tx) =>
        insertRecord(
          tx,
          dummyRecord,
          dummyValues(t.organisationId, t.projectId),
          ctx,
        ),
      );
      expect(await seqsFor(database, t.organisationId, t.projectId)).toEqual([
        1, 2,
      ]);
    });

    it('gives the seq back when a failed write is caught inside the same transaction', async () => {
      const t = await seedTenant(database);
      const ctx = contextFor(userId);
      await database.db.transaction(async (tx) => {
        const first = await insertRecord(
          tx,
          dummyRecord,
          dummyValues(t.organisationId, t.projectId),
          ctx,
        );
        await expect(
          updateRecord(tx, dummyRecord, first.id, 99, { title: 'x' }, ctx),
        ).rejects.toBeInstanceOf(VersionConflictError);
        await expect(
          insertRecord(tx, dummyRecord, dummyValues(newId(), t.projectId), ctx),
        ).rejects.toBeInstanceOf(RecordWriteError);
        await insertRecord(
          tx,
          dummyRecord,
          dummyValues(t.organisationId, t.projectId),
          ctx,
        );
      });
      expect(await seqsFor(database, t.organisationId, t.projectId)).toEqual([
        1, 2,
      ]);
    });

    it('numbers events 1, 2, 3 per project, separately for each project and for the organisation', async () => {
      const a = await seedTenant(database);
      const b = await seedTenant(database);
      const ctx = contextFor(userId);
      const write = (organisationId: string, projectId: string | null) =>
        database.db.transaction((tx) =>
          insertRecord(
            tx,
            dummyRecord,
            dummyValues(organisationId, projectId),
            ctx,
          ),
        );
      await write(a.organisationId, a.projectId);
      await write(a.organisationId, null);
      await write(a.organisationId, a.projectId);
      await write(b.organisationId, b.projectId);
      await write(a.organisationId, null);
      await write(a.organisationId, a.projectId);
      expect(await seqsFor(database, a.organisationId, a.projectId)).toEqual([
        1, 2, 3,
      ]);
      expect(await seqsFor(database, a.organisationId, null)).toEqual([1, 2]);
      expect(await seqsFor(database, b.organisationId, b.projectId)).toEqual([
        1,
      ]);
      expect(await seqsFor(database, b.organisationId, null)).toEqual([]);
    });

    it('logs a project record against that project’s own sequence', async () => {
      const t = await seedTenant(database);
      const ctx = contextFor(userId);
      const updated = await database.db.transaction((tx) =>
        updateRecord(tx, project, t.projectId, 1, { title: 'Renamed' }, ctx),
      );
      expect(updated.title).toBe('Renamed');
      const [event] = await eventsFor(database, t.projectId);
      expect(event).toMatchObject({
        entityType: 'project',
        projectId: t.projectId,
        seq: 1,
        changedFields: ['title'],
      });
    });

    describe('project of child records', () => {
      const PERMISSION_KEY = 'budget:read';
      const OTHER_PERMISSION_KEY = 'budget:write';

      beforeAll(async () => {
        await database.db.insert(permission).values([
          { key: PERMISSION_KEY, module: 'budget', description: 'Read' },
          { key: OTHER_PERMISSION_KEY, module: 'budget', description: 'Write' },
        ]);
      });

      const insertRole = (
        t: { organisationId: string },
        projectId: string | null,
        ctx: WriteContext,
      ) =>
        database.db.transaction((tx) =>
          insertRecord(
            tx,
            role,
            {
              organisationId: t.organisationId,
              ownerOrgId: t.organisationId,
              projectId,
              key: 'line-producer',
              name: 'Line producer',
            },
            ctx,
          ),
        );

      const grant = (
        t: { organisationId: string },
        roleId: string,
        permissionKey: string,
        ctx: WriteContext,
      ) =>
        database.db.transaction((tx) =>
          insertRecord(
            tx,
            rolePermission,
            {
              organisationId: t.organisationId,
              ownerOrgId: t.organisationId,
              roleId,
              permissionKey,
            },
            ctx,
          ),
        );

      it("puts a project role's permission in that project's sequence, for every action", async () => {
        const t = await seedTenant(database);
        const ctx = contextFor(userId);
        const projectRole = await insertRole(t, t.projectId, ctx);
        const grantRow = await grant(t, projectRole.id, PERMISSION_KEY, ctx);
        const updated = await database.db.transaction((tx) =>
          updateRecord(
            tx,
            rolePermission,
            grantRow.id,
            1,
            { permissionKey: OTHER_PERMISSION_KEY },
            ctx,
          ),
        );
        const deleted = await database.db.transaction((tx) =>
          softDeleteRecord(tx, rolePermission, grantRow.id, 2, ctx),
        );
        await database.db.transaction((tx) =>
          restoreRecord(tx, rolePermission, grantRow.id, deleted.version, ctx),
        );
        expect(updated.version).toBe(2);
        const events = await eventsFor(database, grantRow.id);
        expect(events.map((e) => [e.action, e.projectId, e.seq])).toEqual([
          ['create', t.projectId, 2],
          ['update', t.projectId, 3],
          ['delete', t.projectId, 4],
          ['restore', t.projectId, 5],
        ]);
        expect(await seqsFor(database, t.organisationId, t.projectId)).toEqual([
          1, 2, 3, 4, 5,
        ]);
        expect(await seqsFor(database, t.organisationId, null)).toEqual([]);
      });

      it("puts an organisation template role's permission in the organisation sequence", async () => {
        const t = await seedTenant(database);
        const ctx = contextFor(userId);
        const template = await insertRole(t, null, ctx);
        const grantRow = await grant(t, template.id, PERMISSION_KEY, ctx);
        await database.db.transaction((tx) =>
          softDeleteRecord(tx, rolePermission, grantRow.id, 1, ctx),
        );
        const events = await eventsFor(database, grantRow.id);
        expect(events.map((e) => [e.action, e.projectId, e.seq])).toEqual([
          ['create', null, 2],
          ['delete', null, 3],
        ]);
        expect(await seqsFor(database, t.organisationId, null)).toEqual([
          1, 2, 3,
        ]);
        expect(await seqsFor(database, t.organisationId, t.projectId)).toEqual(
          [],
        );
      });

      it('puts a membership role in the project of its membership', async () => {
        const t = await seedTenant(database);
        const ctx = contextFor(userId);
        const member = await seedUser(database);
        const membership = await database.db.transaction((tx) =>
          insertRecord(
            tx,
            projectMembership,
            {
              organisationId: t.organisationId,
              ownerOrgId: t.organisationId,
              projectId: t.projectId,
              userId: member,
              status: 'active',
            },
            ctx,
          ),
        );
        // An organisation template role: the role's own project is no help,
        // so the project can only come from the membership.
        const template = await insertRole(t, null, ctx);
        const link = await database.db.transaction((tx) =>
          insertRecord(
            tx,
            projectMembershipRole,
            {
              organisationId: t.organisationId,
              ownerOrgId: t.organisationId,
              membershipId: membership.id,
              roleId: template.id,
            },
            ctx,
          ),
        );
        await database.db.transaction((tx) =>
          softDeleteRecord(tx, projectMembershipRole, link.id, 1, ctx),
        );
        const events = await eventsFor(database, link.id);
        expect(events.map((e) => [e.action, e.projectId, e.seq])).toEqual([
          ['create', t.projectId, 2],
          ['delete', t.projectId, 3],
        ]);
        expect(await seqsFor(database, t.organisationId, t.projectId)).toEqual([
          1, 2, 3,
        ]);
        // Only the template role itself is in the organisation sequence.
        expect(await seqsFor(database, t.organisationId, null)).toEqual([1]);
      });

      it('writes nothing, and uses no seq, when the parent does not exist', async () => {
        const t = await seedTenant(database);
        const ctx = contextFor(userId);
        const id = newId();
        let thrown: unknown;
        try {
          await database.db.transaction((tx) =>
            insertRecord(
              tx,
              rolePermission,
              {
                id,
                organisationId: t.organisationId,
                ownerOrgId: t.organisationId,
                roleId: newId(),
                permissionKey: PERMISSION_KEY,
              },
              ctx,
            ),
          );
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(RecordWriteError);
        expect(thrown).toMatchObject({
          code: SQLSTATE.foreignKeyViolation,
          constraint: 'role_permission_role_fk',
        });
        expect(await eventsFor(database, id)).toHaveLength(0);
        expect(await seqsFor(database, t.organisationId, null)).toEqual([]);
      });

      it('refuses a second resolver for the same table', () => {
        expect(() =>
          registerProjectResolver(rolePermission, () => Promise.resolve(null)),
        ).toThrow(/already registered for role_permission/);
      });
    });

    it.skipIf(target.name === 'pglite')(
      'PostgreSQL only (skipped on PGlite, which has a single connection): 20 concurrent writes to one project get seq 1 to 20 with no gaps or duplicates',
      async () => {
        const t = await seedTenant(database);
        const ctx = contextFor(userId);
        await Promise.all(
          Array.from({ length: 20 }, () =>
            database.db.transaction((tx) =>
              insertRecord(
                tx,
                dummyRecord,
                dummyValues(t.organisationId, t.projectId),
                ctx,
              ),
            ),
          ),
        );
        expect(await seqsFor(database, t.organisationId, t.projectId)).toEqual(
          Array.from({ length: 20 }, (_, i) => i + 1),
        );
      },
      30_000,
    );

    it('throws VersionConflictError for a stale expectedVersion and writes nothing', async () => {
      const t = await seedTenant(database);
      const ctx = contextFor(userId);
      const created = await database.db.transaction((tx) =>
        insertRecord(
          tx,
          dummyRecord,
          dummyValues(t.organisationId, t.projectId),
          ctx,
        ),
      );
      await database.db.transaction((tx) =>
        updateRecord(tx, dummyRecord, created.id, 1, { title: 'Second' }, ctx),
      );

      const attempt = database.db.transaction((tx) =>
        updateRecord(tx, dummyRecord, created.id, 1, { title: 'Stale' }, ctx),
      );
      await expect(attempt).rejects.toBeInstanceOf(VersionConflictError);
      await expect(attempt).rejects.toMatchObject({
        entityType: 'dummy_record',
        entityId: created.id,
        expectedVersion: 1,
        actualVersion: 2,
      });
      await expect(
        database.db.transaction((tx) =>
          softDeleteRecord(tx, dummyRecord, created.id, 1, ctx),
        ),
      ).rejects.toBeInstanceOf(VersionConflictError);
      await expect(
        database.db.transaction((tx) =>
          restoreRecord(tx, dummyRecord, created.id, 1, ctx),
        ),
      ).rejects.toBeInstanceOf(VersionConflictError);

      const [row] = await rows(
        database,
        sql`select title, version, deleted_at from dummy_record where id = ${created.id}`,
      );
      expect(row).toEqual({ title: 'Second', version: 2, deleted_at: null });
      expect(await eventsFor(database, created.id)).toHaveLength(2);
      expect(await seqsFor(database, t.organisationId, t.projectId)).toEqual([
        1, 2,
      ]);
    });

    it('throws RecordNotFoundError for an unknown id', async () => {
      const ctx = contextFor(userId);
      await expect(
        database.db.transaction((tx) =>
          updateRecord(tx, dummyRecord, newId(), 1, { title: 'x' }, ctx),
        ),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
    });

    it('refuses to change identity columns or unknown columns', async () => {
      const t = await seedTenant(database);
      const ctx = contextFor(userId);
      const created = await database.db.transaction((tx) =>
        insertRecord(
          tx,
          dummyRecord,
          dummyValues(t.organisationId, t.projectId),
          ctx,
        ),
      );
      for (const patch of [
        { organisationId: newId() },
        { projectId: null },
        { id: newId() },
        { nonsense: 'x' },
      ]) {
        await expect(
          database.db.transaction((tx) =>
            updateRecord(tx, dummyRecord, created.id, 1, patch as never, ctx),
          ),
        ).rejects.toThrow(/cannot be changed|Unknown column/);
      }
      expect(await eventsFor(database, created.id)).toHaveLength(1);
    });

    it('reports only the changed fields on update', async () => {
      const t = await seedTenant(database);
      const ctx = contextFor(userId);
      const created = await database.db.transaction((tx) =>
        insertRecord(
          tx,
          dummyRecord,
          dummyValues(t.organisationId, t.projectId),
          ctx,
        ),
      );
      await database.db.transaction((tx) =>
        updateRecord(
          tx,
          dummyRecord,
          created.id,
          1,
          { title: 'Call sheet', visibility: 'private' },
          ctx,
        ),
      );
      const [, event] = await eventsFor(database, created.id);
      expect(event).toMatchObject({
        changedFields: ['visibility'],
        before: { visibility: 'project' },
        after: { visibility: 'private' },
      });
    });

    describe('sensitive fields', () => {
      it('registers sensitive columns by database name and rejects unknown ones', () => {
        expect([...sensitiveColumns(dummyRecord)]).toEqual(['secret_note']);
        expect(() => markSensitive(dummyRecord, ['nonsense' as never])).toThrow(
          'unknown column',
        );
        expect(sensitiveColumns(project).size).toBe(0);
      });

      it('never stores a sensitive value in before or after, but keeps the name in changed_fields', async () => {
        const t = await seedTenant(database);
        const ctx = contextFor(userId);
        const created = await database.db.transaction((tx) =>
          insertRecord(
            tx,
            dummyRecord,
            dummyValues(t.organisationId, t.projectId, { secretNote: SECRET }),
            ctx,
          ),
        );
        const updated = await database.db.transaction((tx) =>
          updateRecord(
            tx,
            dummyRecord,
            created.id,
            1,
            { secretNote: OTHER_SECRET, title: 'Retitled' },
            ctx,
          ),
        );
        await database.db.transaction((tx) =>
          softDeleteRecord(tx, dummyRecord, created.id, updated.version, ctx),
        );

        // The row itself holds the value; the log must not.
        expect(created.secretNote).toBe(SECRET);
        const events = await eventsFor(database, created.id);
        const [createEvent, updateEvent] = events;
        expect(createEvent!.changedFields).toContain('secret_note');
        expect(createEvent!.after).not.toHaveProperty('secret_note');
        expect(createEvent!.after).toMatchObject({ title: 'Call sheet' });
        expect(updateEvent!.changedFields.sort()).toEqual([
          'secret_note',
          'title',
        ]);
        expect(updateEvent!.before).toEqual({ title: 'Call sheet' });
        expect(updateEvent!.after).toEqual({ title: 'Retitled' });

        const stored = await rows(
          database,
          sql`select before::text as b, after::text as a, changed_fields::text as c
              from change_event where entity_id = ${created.id}`,
        );
        const everything = JSON.stringify(stored);
        expect(everything).not.toContain(SECRET);
        expect(everything).not.toContain(OTHER_SECRET);
      });

      it('keeps sensitive values out of error messages', async () => {
        const t = await seedTenant(database);
        const ctx = contextFor(userId);
        const failure = await failureOf(() =>
          database.db.transaction((tx) =>
            insertRecord(
              tx,
              dummyRecord,
              dummyValues(newId(), t.projectId, { secretNote: SECRET }),
              ctx,
            ),
          ),
        );
        expect(failure.code).toBe(SQLSTATE.foreignKeyViolation);

        const error = await database.db
          .transaction((tx) =>
            insertRecord(
              tx,
              dummyRecord,
              dummyValues(newId(), t.projectId, { secretNote: SECRET }),
              ctx,
            ),
          )
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RecordWriteError);
        expect(JSON.stringify(error)).not.toContain(SECRET);
        expect(String((error as Error).message)).not.toContain(SECRET);
        expect((error as Error).cause).toBeUndefined();
      });
    });
  });

  describe('append-only logs', () => {
    let t: { organisationId: string; projectId: string };
    beforeAll(async () => {
      t = await seedTenant(database);
      const ctx = contextFor(userId);
      await database.db.transaction((tx) =>
        insertRecord(
          tx,
          dummyRecord,
          dummyValues(t.organisationId, t.projectId),
          ctx,
        ),
      );
      await recordAudit(database.db, {
        organisationId: t.organisationId,
        category: 'auth',
        action: 'sign-in',
        actor: { type: 'user', id: userId },
      });
    });

    const appendOnly = {
      code: APPEND_ONLY_SQLSTATE,
      constraint: undefined,
    };

    for (const table of ['change_event', 'audit_event']) {
      it(`${table} rejects UPDATE`, async () => {
        const failure = await failureOf(() =>
          database.db.execute(
            sql.raw(`update ${table} set request_id = 'changed'`),
          ),
        );
        expect(failure).toEqual(appendOnly);
      });

      it(`${table} rejects UPDATE even when no row matches`, async () => {
        const failure = await failureOf(() =>
          database.db.execute(
            sql.raw(`update ${table} set request_id = 'x' where false`),
          ),
        );
        expect(failure).toEqual(appendOnly);
      });

      it(`${table} rejects DELETE`, async () => {
        const failure = await failureOf(() =>
          database.db.execute(sql.raw(`delete from ${table}`)),
        );
        expect(failure).toEqual(appendOnly);
      });

      it(`${table} rejects TRUNCATE`, async () => {
        const failure = await failureOf(() =>
          database.db.execute(sql.raw(`truncate table ${table}`)),
        );
        expect(failure).toEqual(appendOnly);
      });

      it(`${table} still has its rows after the rejected statements`, async () => {
        const [count] = await rows(
          database,
          sql.raw(`select count(*)::int as n from ${table}`),
        );
        expect(count!.n).toBeGreaterThan(0);
      });
    }

    it('the trigger source matches the migration', () => {
      const migration = readFileSync(
        join(MIGRATIONS_FOLDER, '0004_change_and_audit_logs.sql'),
        'utf8',
      );
      expect(migration).toContain(appendOnlyMigrationSql());
    });
  });

  describe('recordAudit', () => {
    it('stores the event', async () => {
      const t = await seedTenant(database);
      const occurredAt = new Date('2026-02-03T04:05:06.000Z');
      const stored = await recordAudit(database.db, {
        organisationId: t.organisationId,
        projectId: t.projectId,
        category: 'permission',
        action: 'role-granted',
        actor: { type: 'user', id: userId },
        targetType: 'role',
        targetId: newId(),
        details: { role: 'director' },
        ipAddress: '203.0.113.7',
        requestId: 'req-9',
        occurredAt,
      });
      const [row] = await database.db
        .select()
        .from(auditEvent)
        .where(sql`${auditEvent.id} = ${stored.id}`);
      expect(row).toMatchObject({
        organisationId: t.organisationId,
        projectId: t.projectId,
        category: 'permission',
        action: 'role-granted',
        actorType: 'user',
        actorId: userId,
        targetType: 'role',
        details: { role: 'director' },
        ipAddress: '203.0.113.7',
        requestId: 'req-9',
        occurredAt,
      });
    });

    it('allows an install-level event with no organisation', async () => {
      const stored = await recordAudit(database.db, {
        category: 'auth',
        action: 'sign-in-failed',
        actor: { type: 'system', id: null },
      });
      expect(stored.organisationId).toBeNull();
      expect(stored.occurredAt).toBeInstanceOf(Date);
    });

    it('rejects an unknown actor type', async () => {
      const failure = await failureOf(() =>
        recordAudit(database.db, {
          category: 'auth',
          action: 'x',
          actor: { type: 'robot' as never, id: null },
        }),
      );
      expect(failure).toMatchObject({
        code: SQLSTATE.checkViolation,
        constraint: 'audit_event_actor_type_check',
      });
    });
  });

  describe('log table constraints', () => {
    let a: { organisationId: string; projectId: string };
    let b: { organisationId: string; projectId: string };
    beforeAll(async () => {
      a = await seedTenant(database);
      b = await seedTenant(database);
    });

    const eventValues = (
      organisationId: string,
      projectId: string | null,
      seq: number,
    ) => ({
      organisationId,
      projectId,
      seq,
      entityType: 'dummy_record',
      entityId: newId(),
      action: 'create' as const,
      changedFields: ['title'],
      entityVersion: 1,
      actorType: 'system' as const,
      originServer: ORIGIN,
      occurredAt: new Date(),
    });

    it('rejects a change_event that points at another organisation’s project', async () => {
      const failure = await failureOf(() =>
        database.db
          .insert(changeEvent)
          .values(eventValues(a.organisationId, b.projectId, 1)),
      );
      expect(failure).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'change_event_project_fk',
      });
    });

    it('rejects an audit_event that points at another organisation’s project', async () => {
      const failure = await failureOf(() =>
        database.db.insert(auditEvent).values({
          organisationId: a.organisationId,
          projectId: b.projectId,
          category: 'x',
          action: 'y',
          actorType: 'system',
          occurredAt: new Date(),
        }),
      );
      expect(failure).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'audit_event_project_fk',
      });
    });

    it('rejects a change_seq that points at another organisation’s project', async () => {
      const failure = await failureOf(() =>
        database.db.insert(changeSeq).values({
          organisationId: a.organisationId,
          projectId: b.projectId,
          lastSeq: 1,
        }),
      );
      expect(failure).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'change_seq_project_fk',
      });
    });

    it('rejects an unknown organisation on all three tables', async () => {
      const unknown = newId();
      expect(
        await failureOf(() =>
          database.db.insert(changeEvent).values(eventValues(unknown, null, 1)),
        ),
      ).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'change_event_organisation_fk',
      });
      expect(
        await failureOf(() =>
          database.db.insert(auditEvent).values({
            organisationId: unknown,
            category: 'x',
            action: 'y',
            actorType: 'system',
            occurredAt: new Date(),
          }),
        ),
      ).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'audit_event_organisation_fk',
      });
      expect(
        await failureOf(() =>
          database.db
            .insert(changeSeq)
            .values({ organisationId: unknown, projectId: null, lastSeq: 1 }),
        ),
      ).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'change_seq_organisation_fk',
      });
    });

    it('rejects a duplicate seq, including for organisation-level events', async () => {
      for (const projectId of [a.projectId, null]) {
        await database.db
          .insert(changeEvent)
          .values(eventValues(a.organisationId, projectId, 1));
        const failure = await failureOf(() =>
          database.db
            .insert(changeEvent)
            .values(eventValues(a.organisationId, projectId, 1)),
        );
        expect(failure).toEqual({
          code: SQLSTATE.uniqueViolation,
          constraint: 'change_event_organisation_project_seq_unique',
        });
      }
    });

    it('allows one change_seq row per project and per organisation only', async () => {
      await database.db.insert(changeSeq).values({
        organisationId: b.organisationId,
        projectId: null,
        lastSeq: 1,
      });
      const failure = await failureOf(() =>
        database.db.insert(changeSeq).values({
          organisationId: b.organisationId,
          projectId: null,
          lastSeq: 1,
        }),
      );
      expect(failure).toEqual({
        code: SQLSTATE.uniqueViolation,
        constraint: 'change_seq_organisation_project_unique',
      });
    });

    it('rejects an unknown action and actor type on change_event', async () => {
      const badAction = await failureOf(() =>
        database.db.insert(changeEvent).values({
          ...eventValues(a.organisationId, a.projectId, 50),
          action: 'merge' as never,
        }),
      );
      expect(badAction).toEqual({
        code: SQLSTATE.checkViolation,
        constraint: 'change_event_action_check',
      });
      const badActor = await failureOf(() =>
        database.db.insert(changeEvent).values({
          ...eventValues(a.organisationId, a.projectId, 51),
          actorType: 'robot' as never,
        }),
      );
      expect(badActor).toEqual({
        code: SQLSTATE.checkViolation,
        constraint: 'change_event_actor_type_check',
      });
    });
  });
});
