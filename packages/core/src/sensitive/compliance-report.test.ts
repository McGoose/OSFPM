import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  base,
  engagePerson,
  ensurePermissions,
  grantOnProject,
  ORIGIN,
  seedDepartment,
  seedOrganisation,
  seedPerson,
  seedProject,
  seedUser,
  type SeedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import type { ProjectPersonStatus } from '../db/schema/index.js';
import { newId } from '../db/ids.js';
import {
  auditEvent,
  orgMembership,
  personSensitive,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  COMPLIANCE_REPORT_PERMISSION,
  readPermissionKey,
  SENSITIVE_PERMISSIONS,
} from './permissions.js';
import {
  complianceReport,
  ComplianceReportDeniedError,
  writeSensitive,
  type SensitiveContext,
} from './service.js';

const NOW = new Date('2026-11-15T10:00:00.000Z');

const ctxFor = (userId: string): SensitiveContext => ({
  userId,
  originServer: ORIGIN,
  clock: () => NOW,
});

describe.each(testTargets)('compliance report on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let s: SeedOrganisation;
  let projectB: string;
  let soundId: string;
  let artId: string;
  let reporter: string;
  let readerOnly: string;
  let reporterOnB: string;
  let owner: string;
  const names = new Map<string, string>();
  const personIds: string[] = [];

  const db = () => database.db;

  /** A person on project A with an optional compliance record. */
  async function addPerson(
    name: string,
    options: {
      departmentId?: string | null;
      compliance?: Record<string, unknown>;
      deletedRecord?: boolean;
      projectId?: string;
      engagements?: number;
      status?: ProjectPersonStatus;
    } = {},
  ) {
    const self = await seedUser(database);
    const personId = await seedPerson(database, s.organisationId, {
      userId: self,
      displayName: name,
    });
    names.set(personId, name);
    personIds.push(personId);
    for (let i = 0; i < (options.engagements ?? 1); i += 1) {
      await engagePerson(
        database,
        s.organisationId,
        options.projectId ?? s.projectId,
        personId,
        {
          departmentId: options.departmentId ?? null,
          engagement: i === 0 ? 'crew' : 'cast',
          characterName: i === 0 ? null : `Double ${i}`,
          ...(options.status ? { status: options.status } : {}),
        },
      );
    }
    if (options.compliance) {
      await writeSensitive(
        db(),
        ctxFor(self),
        personId,
        'compliance',
        options.compliance,
        { legalBasis: 'legal-obligation' },
      );
      if (options.deletedRecord) {
        await db()
          .update(personSensitive)
          .set({ deletedAt: NOW })
          .where(eq(personSensitive.personId, personId));
      }
    }
    return personId;
  }

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    s = await seedOrganisation(database);
    projectB = await seedProject(database, s.organisationId);
    soundId = await seedDepartment(database, s.organisationId, 'sound');
    artId = await seedDepartment(database, s.organisationId, 'art');
    await ensurePermissions(
      database,
      SENSITIVE_PERMISSIONS.map((p) => p.key),
    );
    reporter = await seedUser(database);
    await grantOnProject(database, s.organisationId, s.projectId, reporter, [
      COMPLIANCE_REPORT_PERMISSION,
    ]);
    readerOnly = await seedUser(database);
    await grantOnProject(database, s.organisationId, s.projectId, readerOnly, [
      readPermissionKey('compliance'),
    ]);
    reporterOnB = await seedUser(database);
    await grantOnProject(database, s.organisationId, projectB, reporterOnB, [
      COMPLIANCE_REPORT_PERMISSION,
    ]);
    owner = await seedUser(database);
    await database.db.insert(orgMembership).values({
      ...base(s.organisationId),
      userId: owner,
      orgRole: 'owner',
      status: 'active',
    });
  });
  afterAll(async () => {
    await cleanup();
  });

  it('returns an empty report for a project with nobody engaged', async () => {
    const report = await complianceReport(db(), ctxFor(reporterOnB), projectB);
    expect(report).toEqual({ projectId: projectB, departments: [] });
  });

  describe('with a crew', () => {
    let report: Awaited<ReturnType<typeof complianceReport>>;

    beforeAll(async () => {
      const camera = s.departmentId;
      await addPerson('Alex Demo', {
        departmentId: camera,
        compliance: { taxResidency: 'GB', citizenships: ['GB', 'IE'] },
      });
      await addPerson('Billie Example', {
        departmentId: camera,
        compliance: { taxResidency: 'GB', citizenships: ['GB'] },
      });
      // Two engagements in one department count once.
      await addPerson('Casey Sample', {
        departmentId: camera,
        engagements: 2,
        compliance: { taxResidency: 'GB', citizenships: ['GB'] },
      });
      await addPerson('Dana Invented', {
        departmentId: soundId,
        compliance: { taxResidency: 'FR', citizenships: ['FR'] },
      });
      await addPerson('Eli Placeholder', { departmentId: soundId });
      await addPerson('Frankie Demo', {
        compliance: { taxResidency: 'IE', citizenships: [] },
      });
      await addPerson('Gale Example', {
        compliance: { citizenships: ['GB'] },
        deletedRecord: true,
      });
      // Released people worked on the production: they count.
      await addPerson('Jules Released', {
        departmentId: soundId,
        status: 'released',
        compliance: { taxResidency: 'FR', citizenships: ['FR'] },
      });
      // Proposed people have not joined yet: they do not count, and a
      // department with only proposed people does not appear.
      await addPerson('Ivy Proposed', {
        departmentId: s.departmentId,
        status: 'proposed',
        compliance: { taxResidency: 'GB', citizenships: ['GB'] },
      });
      await addPerson('Lee Proposed', {
        departmentId: artId,
        status: 'proposed',
        compliance: { taxResidency: 'GB', citizenships: ['GB'] },
      });
      // Engaged on another project only: must not appear.
      await addPerson('Harper Elsewhere', {
        projectId: projectB,
        compliance: { taxResidency: 'DE', citizenships: ['DE'] },
      });
      report = await complianceReport(db(), ctxFor(reporter), s.projectId);
    });

    it('counts people per department by tax residency and citizenship, with unknown', () => {
      const byName = Object.fromEntries(
        report.departments.map((d) => [d.departmentName ?? 'none', d]),
      );
      expect(Object.keys(byName).sort()).toEqual(['Camera', 'none', 'sound']);
      expect(byName.Camera).toMatchObject({
        departmentId: s.departmentId,
        engagedPeople: 3,
        taxResidency: { GB: 3 },
        citizenship: { GB: 3, IE: 1 },
      });
      expect(byName.sound).toMatchObject({
        departmentId: soundId,
        engagedPeople: 3,
        taxResidency: { FR: 2, unknown: 1 },
        citizenship: { FR: 2, unknown: 1 },
      });
      expect(byName.none).toMatchObject({
        departmentId: null,
        engagedPeople: 2,
        taxResidency: { IE: 1, unknown: 1 },
        citizenship: { unknown: 2 },
      });
    });

    it('lists the no-department group last', () => {
      expect(report.departments.at(-1)?.departmentId).toBeNull();
    });

    it('returns counts only: no person ids, names or payload fields', () => {
      const text = JSON.stringify(report);
      for (const [personId, name] of names) {
        expect(text).not.toContain(personId);
        expect(text).not.toContain(name);
      }
      expect(Object.keys(report).sort()).toEqual(['departments', 'projectId']);
      for (const department of report.departments) {
        expect(Object.keys(department).sort()).toEqual([
          'citizenship',
          'departmentId',
          'departmentName',
          'engagedPeople',
          'taxResidency',
        ]);
        for (const counts of [
          department.taxResidency,
          department.citizenship,
        ]) {
          for (const [key, value] of Object.entries(counts)) {
            expect(key).toMatch(/^([A-Z]{2}|unknown)$/);
            expect(Number.isInteger(value)).toBe(true);
          }
        }
      }
    });

    it('writes one compliance.report audit event, without values', async () => {
      const events = await db()
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.category, 'compliance.report'));
      expect(events.length).toBeGreaterThanOrEqual(1);
      const [event] = events.filter((e) => e.targetId === s.projectId);
      expect(event).toMatchObject({
        actorId: reporter,
        targetType: 'project',
        targetId: s.projectId,
        projectId: s.projectId,
        organisationId: s.organisationId,
      });
      expect(JSON.stringify(event?.details ?? null)).not.toMatch(/GB|FR|IE/);
    });
  });

  describe('permission', () => {
    const denied = async (userId: string, projectId = s.projectId) => {
      const error = await complianceReport(
        db(),
        ctxFor(userId),
        projectId,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ComplianceReportDeniedError);
      return error;
    };

    it('is denied without compliance:report, even with sensitive:read:compliance', async () => {
      await denied(readerOnly);
    });

    it('is denied for an org owner without project grants', async () => {
      await denied(owner);
    });

    it('is denied when the permission is held on another project only', async () => {
      await denied(reporterOnB);
    });

    it('is denied for an unknown project', async () => {
      await denied(reporter, newId());
    });

    it('audits each denial as sensitive.denied', async () => {
      await denied(readerOnly);
      const events = await db()
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.category, 'sensitive.denied'));
      const mine = events.filter(
        (e) => e.targetId === s.projectId && e.actorId === readerOnly,
      );
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(mine[0]).toMatchObject({
        targetType: 'project',
        action: 'report',
        projectId: s.projectId,
      });
    });
  });
});
