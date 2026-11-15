import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensurePermissions,
  grantOnOrganisation,
  grantOnProject,
  ORIGIN,
  seedOrganisation,
  seedProject,
  seedUser,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { auditEvent, changeEvent, legalHold } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';
import { RecordStateError, RecordWriteError } from '../db/write.js';
import {
  LEGAL_HOLD_MANAGE_PERMISSION,
  LEGAL_HOLD_PERMISSIONS,
} from './permissions.js';
import {
  isUnderLegalHold,
  LegalHoldAccessDeniedError,
  LegalHoldInputError,
  placeLegalHold,
  releaseLegalHold,
  type LegalHoldContext,
} from './service.js';

const PLACED_AT = new Date(Date.UTC(2026, 0, 1, 12));
const RELEASED_AT = new Date(Date.UTC(2026, 0, 2, 12));

const ctxFor = (
  userId: string,
  clock: () => Date = () => PLACED_AT,
): LegalHoldContext => ({ userId, originServer: ORIGIN, clock });

const REASON = 'Dispute over the second unit invoice';
const RELEASE_REASON = 'Dispute settled';

describe('legal hold permission', () => {
  it('is one catalogue row for the legal-hold module', () => {
    expect(LEGAL_HOLD_PERMISSIONS).toEqual([
      {
        key: 'legal-hold:manage',
        module: 'legal-hold',
        description: 'Place and release legal holds',
        grantsSensitive: false,
      },
    ]);
    expect(LEGAL_HOLD_MANAGE_PERMISSION).toBe('legal-hold:manage');
  });
});

describe.each(testTargets)('legal holds on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  const db = () => database.db;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    await ensurePermissions(database, [LEGAL_HOLD_MANAGE_PERMISSION]);
  });
  afterAll(async () => {
    await cleanup();
  });

  /** An organisation with a project, a project manager and an organisation manager. */
  async function setup() {
    const org = await seedOrganisation(database);
    const projectManager = await seedUser(database);
    const organisationManager = await seedUser(database);
    const outsider = await seedUser(database);
    await grantOnProject(
      database,
      org.organisationId,
      org.projectId,
      projectManager,
      [LEGAL_HOLD_MANAGE_PERMISSION],
    );
    await grantOnOrganisation(
      database,
      org.organisationId,
      organisationManager,
      'admin',
      [LEGAL_HOLD_MANAGE_PERMISSION],
    );
    return { ...org, projectManager, organisationManager, outsider };
  }

  const holdRows = (organisationId: string) =>
    database.db
      .select()
      .from(legalHold)
      .where(eq(legalHold.organisationId, organisationId));

  const changesOf = (holdId: string) =>
    database.db
      .select()
      .from(changeEvent)
      .where(
        and(
          eq(changeEvent.entityType, 'legal_hold'),
          eq(changeEvent.entityId, holdId),
        ),
      )
      .orderBy(asc(changeEvent.seq));

  const auditOf = (organisationId: string, category?: string) =>
    database.db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.organisationId, organisationId),
          category ? eq(auditEvent.category, category) : undefined,
        ),
      )
      .orderBy(asc(auditEvent.occurredAt));

  /** A hold row inserted straight into the table, for the CHECK tests. */
  const rawHold = (
    organisationId: string,
    overrides: Partial<typeof legalHold.$inferInsert> = {},
  ) => ({
    organisationId,
    ownerOrgId: organisationId,
    originServer: ORIGIN,
    reason: REASON,
    placedAt: PLACED_AT,
    ...overrides,
  });

  describe('the legal_hold table', () => {
    it('accepts organisation, project and record scopes', async () => {
      const { organisationId, projectId } = await setup();
      await db().insert(legalHold).values(rawHold(organisationId));
      await db()
        .insert(legalHold)
        .values(rawHold(organisationId, { projectId }));
      await db()
        .insert(legalHold)
        .values(
          rawHold(organisationId, {
            entityType: 'person',
            entityId: newId(),
          }),
        );
      await db()
        .insert(legalHold)
        .values(
          rawHold(organisationId, {
            projectId,
            entityType: 'person',
            entityId: newId(),
          }),
        );
      const rows = await holdRows(organisationId);
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.retentionClass === 'standard')).toBe(true);
      expect(rows.every((r) => r.visibility === 'private')).toBe(true);
    });

    it.each([
      ['an entity type without an id', { entityType: 'person' }],
      ['an entity id without a type', { entityId: newId() }],
    ])('refuses %s', async (_name, overrides) => {
      const { organisationId } = await setup();
      expect(
        await failureOf(() =>
          db().insert(legalHold).values(rawHold(organisationId, overrides)),
        ),
      ).toEqual({
        code: SQLSTATE.checkViolation,
        constraint: 'legal_hold_entity_check',
      });
    });

    it.each([
      ['a release time alone', { releasedAt: RELEASED_AT }],
      [
        'a release time and user without a reason',
        { releasedAt: RELEASED_AT, releasedBy: 'user' },
      ],
      [
        'a release time and reason without a user',
        { releasedAt: RELEASED_AT, releaseReason: RELEASE_REASON },
      ],
      ['a release reason alone', { releaseReason: RELEASE_REASON }],
      ['a releasing user alone', { releasedBy: 'user' }],
    ])('refuses %s', async (_name, overrides) => {
      const { organisationId, outsider } = await setup();
      const values = {
        ...overrides,
        ...('releasedBy' in overrides ? { releasedBy: outsider } : {}),
      };
      expect(
        await failureOf(() =>
          db().insert(legalHold).values(rawHold(organisationId, values)),
        ),
      ).toEqual({
        code: SQLSTATE.checkViolation,
        constraint: 'legal_hold_release_check',
      });
    });

    it('accepts a complete release', async () => {
      const { organisationId, outsider } = await setup();
      await db()
        .insert(legalHold)
        .values(
          rawHold(organisationId, {
            releasedAt: RELEASED_AT,
            releasedBy: outsider,
            releaseReason: RELEASE_REASON,
          }),
        );
      expect(await holdRows(organisationId)).toHaveLength(1);
    });

    it('refuses a release before the placement', async () => {
      const { organisationId, outsider } = await setup();
      expect(
        await failureOf(() =>
          db()
            .insert(legalHold)
            .values(
              rawHold(organisationId, {
                releasedAt: new Date(PLACED_AT.getTime() - 1),
                releasedBy: outsider,
                releaseReason: RELEASE_REASON,
              }),
            ),
        ),
      ).toEqual({
        code: SQLSTATE.checkViolation,
        constraint: 'legal_hold_released_after_placed_check',
      });
    });

    it('accepts a release at the same moment as the placement', async () => {
      const { organisationId, outsider } = await setup();
      await db()
        .insert(legalHold)
        .values(
          rawHold(organisationId, {
            releasedAt: PLACED_AT,
            releasedBy: outsider,
            releaseReason: RELEASE_REASON,
          }),
        );
      expect(await holdRows(organisationId)).toHaveLength(1);
    });

    it('refuses a soft delete, on insert and on update', async () => {
      const { organisationId } = await setup();
      expect(
        await failureOf(() =>
          db()
            .insert(legalHold)
            .values(rawHold(organisationId, { deletedAt: PLACED_AT })),
        ),
      ).toEqual({
        code: SQLSTATE.checkViolation,
        constraint: 'legal_hold_not_deleted_check',
      });
      const [row] = await db()
        .insert(legalHold)
        .values(rawHold(organisationId))
        .returning();
      expect(
        await failureOf(() =>
          db()
            .update(legalHold)
            .set({ deletedAt: RELEASED_AT })
            .where(eq(legalHold.id, row!.id)),
        ),
      ).toEqual({
        code: SQLSTATE.checkViolation,
        constraint: 'legal_hold_not_deleted_check',
      });
    });

    it('refuses a project of another organisation', async () => {
      const first = await setup();
      const second = await setup();
      expect(
        await failureOf(() =>
          db()
            .insert(legalHold)
            .values(
              rawHold(second.organisationId, { projectId: first.projectId }),
            ),
        ),
      ).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'legal_hold_project_fk',
      });
    });

    it('refuses a releasing user that does not exist', async () => {
      const { organisationId } = await setup();
      expect(
        await failureOf(() =>
          db()
            .insert(legalHold)
            .values(
              rawHold(organisationId, {
                releasedAt: RELEASED_AT,
                releasedBy: newId(),
                releaseReason: RELEASE_REASON,
              }),
            ),
        ),
      ).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'legal_hold_released_by_fk',
      });
    });
  });

  describe('placeLegalHold', () => {
    it('writes the hold, one change event and one audit event', async () => {
      const { organisationId, projectId, projectManager } = await setup();
      const hold = await placeLegalHold(db(), ctxFor(projectManager), {
        organisationId,
        projectId,
        reason: REASON,
      });
      expect(hold).toMatchObject({
        organisationId,
        projectId,
        entityType: null,
        entityId: null,
        reason: REASON,
        placedAt: PLACED_AT,
        releasedAt: null,
        retentionClass: 'standard',
        visibility: 'private',
        createdBy: projectManager,
        version: 1,
      });
      const changes = await changesOf(hold.id);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        action: 'create',
        projectId,
        actorType: 'user',
        actorId: projectManager,
      });
      const audits = await auditOf(organisationId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        category: 'legal-hold.placed',
        action: 'place',
        actorType: 'user',
        actorId: projectManager,
        projectId,
        targetType: 'legal_hold',
        targetId: hold.id,
        details: { scope: 'project', entityType: null },
      });
    });

    it('does not copy the reason or the record id into the audit event', async () => {
      const { organisationId, organisationManager } = await setup();
      const entityId = newId();
      const hold = await placeLegalHold(db(), ctxFor(organisationManager), {
        organisationId,
        entityType: 'person',
        entityId,
        reason: 'Unique reason text 4821',
      });
      const audits = await auditOf(organisationId, 'legal-hold.placed');
      const text = JSON.stringify(audits);
      expect(text).not.toContain('Unique reason text 4821');
      expect(text).not.toContain(entityId);
      expect(audits[0]!.details).toEqual({
        scope: 'record',
        entityType: 'person',
      });
      expect(hold.entityId).toBe(entityId);
    });

    it('lets a project manager hold the project and a record in it', async () => {
      const { organisationId, projectId, projectManager } = await setup();
      const entityId = newId();
      const hold = await placeLegalHold(db(), ctxFor(projectManager), {
        organisationId,
        projectId,
        entityType: 'unit',
        entityId,
        reason: REASON,
      });
      expect(hold).toMatchObject({ projectId, entityType: 'unit', entityId });
      expect((await auditOf(organisationId))[0]!.details).toMatchObject({
        scope: 'record',
      });
    });

    it('checks whole-organisation holds and projectless record holds in the organisation', async () => {
      const { organisationId, organisationManager } = await setup();
      const whole = await placeLegalHold(db(), ctxFor(organisationManager), {
        organisationId,
        reason: REASON,
      });
      const record = await placeLegalHold(db(), ctxFor(organisationManager), {
        organisationId,
        entityType: 'company',
        entityId: newId(),
        reason: REASON,
      });
      expect(whole.projectId).toBeNull();
      expect(record.projectId).toBeNull();
      expect(
        (await auditOf(organisationId, 'legal-hold.placed')).map(
          (a) => a.details,
        ),
      ).toEqual([
        { scope: 'organisation', entityType: null },
        { scope: 'record', entityType: 'company' },
      ]);
    });

    it('refuses a user without legal-hold:manage, audits the denial and writes no hold', async () => {
      const { organisationId, projectId, outsider } = await setup();
      for (const values of [
        { organisationId, projectId, reason: REASON },
        { organisationId, reason: REASON },
        {
          organisationId,
          entityType: 'person',
          entityId: newId(),
          reason: REASON,
        },
      ]) {
        await expect(
          placeLegalHold(db(), ctxFor(outsider), values),
        ).rejects.toBeInstanceOf(LegalHoldAccessDeniedError);
      }
      expect(await holdRows(organisationId)).toEqual([]);
      const denied = await auditOf(organisationId, 'legal-hold.denied');
      expect(denied).toHaveLength(3);
      expect(denied[0]).toMatchObject({
        action: 'place',
        actorId: outsider,
        details: { scope: 'project', entityType: null },
      });
      expect(await auditOf(organisationId, 'legal-hold.placed')).toEqual([]);
    });

    it('keeps the denial audit event when the caller catches the error and commits', async () => {
      const { organisationId, projectId, outsider } = await setup();
      await db().transaction(async (tx) => {
        await expect(
          placeLegalHold(tx, ctxFor(outsider), {
            organisationId,
            projectId,
            reason: REASON,
          }),
        ).rejects.toBeInstanceOf(LegalHoldAccessDeniedError);
      });
      expect(await auditOf(organisationId, 'legal-hold.denied')).toHaveLength(
        1,
      );
    });

    it('does not let a project manager place an organisation-wide hold, nor an organisation manager a project hold', async () => {
      const { organisationId, projectId, projectManager, organisationManager } =
        await setup();
      await expect(
        placeLegalHold(db(), ctxFor(projectManager), {
          organisationId,
          reason: REASON,
        }),
      ).rejects.toBeInstanceOf(LegalHoldAccessDeniedError);
      await expect(
        placeLegalHold(db(), ctxFor(organisationManager), {
          organisationId,
          projectId,
          reason: REASON,
        }),
      ).rejects.toBeInstanceOf(LegalHoldAccessDeniedError);
      expect(await holdRows(organisationId)).toEqual([]);
    });

    it('does not let a manager of one project hold another project', async () => {
      const { organisationId, projectManager } = await setup();
      const otherProject = await seedProject(database, organisationId);
      await expect(
        placeLegalHold(db(), ctxFor(projectManager), {
          organisationId,
          projectId: otherProject,
          reason: REASON,
        }),
      ).rejects.toBeInstanceOf(LegalHoldAccessDeniedError);
    });

    it('refuses a project of another organisation without writing anything', async () => {
      const first = await setup();
      const second = await setup();
      // The user manages the project they name, but it is not in the organisation they name.
      const error = await placeLegalHold(db(), ctxFor(first.projectManager), {
        organisationId: second.organisationId,
        projectId: first.projectId,
        reason: REASON,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RecordWriteError);
      // The write helper takes the project's change counter first, and that
      // foreign key refuses the mismatch before the hold row is tried; the
      // table's own `legal_hold_project_fk` is tested above.
      expect(error).toMatchObject({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'change_seq_project_fk',
      });
      expect(await holdRows(second.organisationId)).toEqual([]);
      expect(await auditOf(second.organisationId)).toEqual([]);
    });

    it('refuses an empty reason and a half-set record before writing', async () => {
      const { organisationId, projectId, projectManager } = await setup();
      await expect(
        placeLegalHold(db(), ctxFor(projectManager), {
          organisationId,
          projectId,
          reason: '   ',
        }),
      ).rejects.toBeInstanceOf(LegalHoldInputError);
      await expect(
        placeLegalHold(db(), ctxFor(projectManager), {
          organisationId,
          projectId,
          entityType: 'person',
          reason: REASON,
        }),
      ).rejects.toBeInstanceOf(LegalHoldInputError);
      expect(await holdRows(organisationId)).toEqual([]);
    });

    describe('when the audit event cannot be written', () => {
      async function refuseAudit() {
        await db().execute(
          sql.raw(`create function osfpm_test_refuse_audit() returns trigger
                   language plpgsql as $$
                   begin
                     raise exception 'audit refused' using errcode = 'P0001';
                   end $$`),
        );
        await db().execute(
          sql.raw(`create trigger osfpm_test_refuse_audit
                   before insert on audit_event
                   for each row execute function osfpm_test_refuse_audit()`),
        );
      }
      async function allowAudit() {
        await db().execute(
          sql.raw('drop trigger osfpm_test_refuse_audit on audit_event'),
        );
        await db().execute(sql.raw('drop function osfpm_test_refuse_audit()'));
      }

      it('leaves no hold and no change event behind on place', async () => {
        const { organisationId, projectId, projectManager } = await setup();
        await refuseAudit();
        try {
          // The caller catches the error and carries on, as a service layer might.
          await db().transaction(async (tx) => {
            await expect(
              placeLegalHold(tx, ctxFor(projectManager), {
                organisationId,
                projectId,
                reason: REASON,
              }),
            ).rejects.toBeInstanceOf(RecordWriteError);
          });
        } finally {
          await allowAudit();
        }
        expect(await holdRows(organisationId)).toEqual([]);
        const changes = await db()
          .select()
          .from(changeEvent)
          .where(
            and(
              eq(changeEvent.organisationId, organisationId),
              eq(changeEvent.entityType, 'legal_hold'),
            ),
          );
        expect(changes).toEqual([]);
      });

      it('leaves the hold unreleased and writes no change event on release', async () => {
        const { organisationId, projectId, projectManager } = await setup();
        const hold = await placeLegalHold(db(), ctxFor(projectManager), {
          organisationId,
          projectId,
          reason: REASON,
        });
        await refuseAudit();
        try {
          await db().transaction(async (tx) => {
            await expect(
              releaseLegalHold(
                tx,
                ctxFor(projectManager, () => RELEASED_AT),
                hold.id,
                RELEASE_REASON,
              ),
            ).rejects.toBeInstanceOf(RecordWriteError);
          });
        } finally {
          await allowAudit();
        }
        const [after] = await holdRows(organisationId);
        expect(after).toMatchObject({
          releasedAt: null,
          releasedBy: null,
          releaseReason: null,
          version: 1,
        });
        expect(await changesOf(hold.id)).toHaveLength(1);
      });
    });
  });

  describe('releaseLegalHold', () => {
    it('writes one change event and one audit event, and sets the release fields', async () => {
      const { organisationId, projectId, projectManager } = await setup();
      const hold = await placeLegalHold(db(), ctxFor(projectManager), {
        organisationId,
        projectId,
        reason: REASON,
      });
      const released = await releaseLegalHold(
        db(),
        ctxFor(projectManager, () => RELEASED_AT),
        hold.id,
        RELEASE_REASON,
      );
      expect(released).toMatchObject({
        id: hold.id,
        releasedAt: RELEASED_AT,
        releasedBy: projectManager,
        releaseReason: RELEASE_REASON,
        deletedAt: null,
        version: 2,
      });
      const changes = await changesOf(hold.id);
      expect(changes.map((c) => c.action)).toEqual(['create', 'update']);
      expect(changes[1]!.changedFields.sort()).toEqual(
        ['release_reason', 'released_at', 'released_by'].sort(),
      );
      const audits = await auditOf(organisationId, 'legal-hold.released');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'release',
        actorId: projectManager,
        targetType: 'legal_hold',
        targetId: hold.id,
        details: { scope: 'project', entityType: null },
      });
      expect(JSON.stringify(audits)).not.toContain(RELEASE_REASON);
      // Place and release: two audit events in all.
      expect(await auditOf(organisationId)).toHaveLength(2);
    });

    it('throws RecordStateError when the hold is already released, and writes nothing', async () => {
      const { organisationId, projectId, projectManager } = await setup();
      const hold = await placeLegalHold(db(), ctxFor(projectManager), {
        organisationId,
        projectId,
        reason: REASON,
      });
      const release = () =>
        releaseLegalHold(
          db(),
          ctxFor(projectManager, () => RELEASED_AT),
          hold.id,
          RELEASE_REASON,
        );
      await release();
      const error = await release().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RecordStateError);
      expect(error).toMatchObject({
        entityType: 'legal_hold',
        entityId: hold.id,
        operation: 'release',
      });
      expect(await changesOf(hold.id)).toHaveLength(2);
      expect(await auditOf(organisationId)).toHaveLength(2);
      const [row] = await holdRows(organisationId);
      expect(row!.version).toBe(2);
    });

    it('refuses a user without legal-hold:manage and leaves the hold in place', async () => {
      const { organisationId, projectId, projectManager, outsider } =
        await setup();
      const hold = await placeLegalHold(db(), ctxFor(projectManager), {
        organisationId,
        projectId,
        reason: REASON,
      });
      await expect(
        releaseLegalHold(db(), ctxFor(outsider), hold.id, RELEASE_REASON),
      ).rejects.toBeInstanceOf(LegalHoldAccessDeniedError);
      const [row] = await holdRows(organisationId);
      expect(row).toMatchObject({ releasedAt: null, version: 1 });
      const denied = await auditOf(organisationId, 'legal-hold.denied');
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({
        action: 'release',
        actorId: outsider,
        targetId: hold.id,
      });
    });

    it('checks the scope of the hold: an organisation hold needs the organisation permission', async () => {
      const { organisationId, projectManager, organisationManager } =
        await setup();
      const hold = await placeLegalHold(db(), ctxFor(organisationManager), {
        organisationId,
        reason: REASON,
      });
      await expect(
        releaseLegalHold(db(), ctxFor(projectManager), hold.id, RELEASE_REASON),
      ).rejects.toBeInstanceOf(LegalHoldAccessDeniedError);
      const released = await releaseLegalHold(
        db(),
        ctxFor(organisationManager, () => RELEASED_AT),
        hold.id,
        RELEASE_REASON,
      );
      expect(released.releasedBy).toBe(organisationManager);
    });

    it('refuses an unknown hold like any other denial', async () => {
      const { organisationManager } = await setup();
      await expect(
        releaseLegalHold(
          db(),
          ctxFor(organisationManager),
          newId(),
          RELEASE_REASON,
        ),
      ).rejects.toBeInstanceOf(LegalHoldAccessDeniedError);
      // No organisation is known for an unknown id, so the event has none.
      const denied = await db()
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.category, 'legal-hold.denied'),
            eq(auditEvent.actorId, organisationManager),
          ),
        );
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({
        organisationId: null,
        targetId: null,
        details: null,
      });
    });

    it('refuses a manager of another organisation', async () => {
      const first = await setup();
      const second = await setup();
      const hold = await placeLegalHold(db(), ctxFor(first.projectManager), {
        organisationId: first.organisationId,
        projectId: first.projectId,
        reason: REASON,
      });
      await expect(
        releaseLegalHold(
          db(),
          ctxFor(second.projectManager),
          hold.id,
          RELEASE_REASON,
        ),
      ).rejects.toBeInstanceOf(LegalHoldAccessDeniedError);
    });

    it('refuses an empty release reason', async () => {
      const { organisationId, projectId, projectManager } = await setup();
      const hold = await placeLegalHold(db(), ctxFor(projectManager), {
        organisationId,
        projectId,
        reason: REASON,
      });
      await expect(
        releaseLegalHold(db(), ctxFor(projectManager), hold.id, ''),
      ).rejects.toBeInstanceOf(LegalHoldInputError);
    });
  });

  describe('isUnderLegalHold', () => {
    it('is false when there are no holds', async () => {
      const { organisationId, projectId } = await setup();
      expect(await isUnderLegalHold(db(), organisationId)).toBe(false);
      expect(await isUnderLegalHold(db(), organisationId, { projectId })).toBe(
        false,
      );
    });

    it('matches an organisation hold for the organisation, any project and any record', async () => {
      const { organisationId, projectId, organisationManager } = await setup();
      await placeLegalHold(db(), ctxFor(organisationManager), {
        organisationId,
        reason: REASON,
      });
      expect(await isUnderLegalHold(db(), organisationId)).toBe(true);
      expect(await isUnderLegalHold(db(), organisationId, { projectId })).toBe(
        true,
      );
      expect(
        await isUnderLegalHold(db(), organisationId, {
          entityType: 'person',
          entityId: newId(),
        }),
      ).toBe(true);
    });

    it('matches a project hold for that project and not for others', async () => {
      const { organisationId, projectId, projectManager } = await setup();
      const otherProject = await seedProject(database, organisationId);
      await placeLegalHold(db(), ctxFor(projectManager), {
        organisationId,
        projectId,
        reason: REASON,
      });
      expect(await isUnderLegalHold(db(), organisationId, { projectId })).toBe(
        true,
      );
      expect(
        await isUnderLegalHold(db(), organisationId, {
          projectId,
          entityType: 'unit',
          entityId: newId(),
        }),
      ).toBe(true);
      expect(
        await isUnderLegalHold(db(), organisationId, {
          projectId: otherProject,
        }),
      ).toBe(false);
      expect(await isUnderLegalHold(db(), organisationId)).toBe(false);
    });

    it('matches a record hold for that record only', async () => {
      const { organisationId, projectId, projectManager, organisationManager } =
        await setup();
      const withProject = newId();
      const withoutProject = newId();
      await placeLegalHold(db(), ctxFor(projectManager), {
        organisationId,
        projectId,
        entityType: 'person',
        entityId: withProject,
        reason: REASON,
      });
      await placeLegalHold(db(), ctxFor(organisationManager), {
        organisationId,
        entityType: 'person',
        entityId: withoutProject,
        reason: REASON,
      });
      for (const entityId of [withProject, withoutProject]) {
        expect(
          await isUnderLegalHold(db(), organisationId, {
            entityType: 'person',
            entityId,
          }),
        ).toBe(true);
      }
      // Another record, another type, and the project itself are not held.
      expect(
        await isUnderLegalHold(db(), organisationId, {
          entityType: 'person',
          entityId: newId(),
        }),
      ).toBe(false);
      expect(
        await isUnderLegalHold(db(), organisationId, {
          entityType: 'company',
          entityId: withProject,
        }),
      ).toBe(false);
      expect(await isUnderLegalHold(db(), organisationId, { projectId })).toBe(
        false,
      );
      expect(await isUnderLegalHold(db(), organisationId)).toBe(false);
    });

    it('ignores released holds', async () => {
      const { organisationId, projectId, projectManager, organisationManager } =
        await setup();
      const entityId = newId();
      const holds = [
        await placeLegalHold(db(), ctxFor(organisationManager), {
          organisationId,
          reason: REASON,
        }),
        await placeLegalHold(db(), ctxFor(projectManager), {
          organisationId,
          projectId,
          reason: REASON,
        }),
        await placeLegalHold(db(), ctxFor(projectManager), {
          organisationId,
          projectId,
          entityType: 'person',
          entityId,
          reason: REASON,
        }),
      ];
      const target = { projectId, entityType: 'person', entityId };
      expect(await isUnderLegalHold(db(), organisationId, target)).toBe(true);
      // Released one by one: the check stays true until the last one goes.
      for (const [index, hold] of holds.entries()) {
        await releaseLegalHold(
          db(),
          ctxFor(
            index === 0 ? organisationManager : projectManager,
            () => RELEASED_AT,
          ),
          hold.id,
          RELEASE_REASON,
        );
        expect(await isUnderLegalHold(db(), organisationId, target)).toBe(
          index < holds.length - 1,
        );
      }
    });

    it('does not match holds of another organisation', async () => {
      const first = await setup();
      const second = await setup();
      const entityId = newId();
      await placeLegalHold(db(), ctxFor(first.organisationManager), {
        organisationId: first.organisationId,
        reason: REASON,
      });
      await placeLegalHold(db(), ctxFor(first.projectManager), {
        organisationId: first.organisationId,
        projectId: first.projectId,
        entityType: 'person',
        entityId,
        reason: REASON,
      });
      expect(await isUnderLegalHold(db(), first.organisationId)).toBe(true);
      expect(await isUnderLegalHold(db(), second.organisationId)).toBe(false);
      expect(
        await isUnderLegalHold(db(), second.organisationId, {
          projectId: second.projectId,
          entityType: 'person',
          entityId,
        }),
      ).toBe(false);
    });

    it('refuses a half-set record', async () => {
      const { organisationId } = await setup();
      await expect(
        isUnderLegalHold(db(), organisationId, { entityType: 'person' }),
      ).rejects.toBeInstanceOf(LegalHoldInputError);
    });
  });
});
