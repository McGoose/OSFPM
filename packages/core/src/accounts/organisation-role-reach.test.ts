import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessDeniedError } from '../access/access-denied-error.js';
import { syncPermissions } from '../access/permission-sync.js';
import {
  grantOnOrganisation,
  grantOnProject,
  ORIGIN,
  seedOrganisation,
  seedProject,
  seedUser,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { project } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { ACCOUNT_PERMISSIONS } from './permissions.js';
import {
  createChart,
  getChart,
  listCharts,
  type AccountContext,
} from './service.js';

// Written out, as in service.test.ts: these keys are stored in role grants.
const READ = 'accounts:read';
const EDIT = 'accounts:edit';

const NOW = new Date(Date.UTC(2026, 1, 1, 12));
const at = (userId: string): AccountContext => ({
  userId,
  originServer: ORIGIN,
  clock: () => NOW,
});

/**
 * An organisation role that reaches into projects, seen through a real service.
 * The user holds only an organisation role: no project membership at all.
 */
describe.each(testTargets)(
  'organisation roles in projects, through charts of accounts on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    const db = () => database.db;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      await syncPermissions(database.db, ACCOUNT_PERMISSIONS);
    });
    afterAll(async () => {
      await cleanup();
    });

    /** An organisation with two projects, each with a chart, and two kinds of reader. */
    async function setup() {
      const org = await seedOrganisation(database);
      const secondProject = await seedProject(database, org.organisationId);
      const editor = await seedUser(database);
      for (const projectId of [org.projectId, secondProject]) {
        await grantOnProject(database, org.organisationId, projectId, editor, [
          EDIT,
        ]);
      }
      const charts = [];
      for (const projectId of [org.projectId, secondProject]) {
        charts.push(
          await createChart(db(), at(editor), {
            organisationId: org.organisationId,
            projectId,
            key: 'main',
            name: 'Main chart',
          }),
        );
      }
      const wide = await seedUser(database);
      await grantOnOrganisation(
        database,
        org.organisationId,
        wide,
        'supervisor',
        [READ],
        { reach: 'all-projects' },
      );
      const narrow = await seedUser(database);
      await grantOnOrganisation(
        database,
        org.organisationId,
        narrow,
        'member',
        [READ],
      );
      return {
        ...org,
        secondProject,
        charts: charts as [(typeof charts)[0], (typeof charts)[0]],
        wide,
        narrow,
      };
    }

    const errorOf = (call: Promise<unknown>) =>
      call.then(
        () => {
          throw new Error('Expected the call to fail, but it succeeded');
        },
        (error: unknown) => error,
      );

    it('lists and reads the charts of every project for an organisation-only user with an all-projects grant', async () => {
      const w = await setup();
      for (const [index, projectId] of [
        w.projectId,
        w.secondProject,
      ].entries()) {
        const listed = await listCharts(db(), at(w.wide), {
          organisationId: w.organisationId,
          projectId,
        });
        expect(listed.map((c) => c.id)).toEqual([w.charts[index]!.id]);
        const read = await getChart(db(), at(w.wide), w.charts[index]!.id);
        expect(read.id).toBe(w.charts[index]!.id);
      }
    });

    it('still lists the organisation templates for that user, as both reaches count at organisation level', async () => {
      const w = await setup();
      expect(
        await listCharts(db(), at(w.wide), {
          organisationId: w.organisationId,
        }),
      ).toEqual([]);
      expect(
        await listCharts(db(), at(w.narrow), {
          organisationId: w.organisationId,
        }),
      ).toEqual([]);
    });

    it('refuses an organisation-only user whose grant is own-scope', async () => {
      const w = await setup();
      const error = await errorOf(
        listCharts(db(), at(w.narrow), {
          organisationId: w.organisationId,
          projectId: w.projectId,
        }),
      );
      expect(error).toBeInstanceOf(AccessDeniedError);
      expect(error).toMatchObject({ permission: READ, scope: 'project' });
      const byId = await errorOf(getChart(db(), at(w.narrow), w.charts[0].id));
      expect(byId).toBeInstanceOf(AccessDeniedError);
      expect((byId as AccessDeniedError).scope).toBeUndefined();
    });

    it('grants only the permission held: an all-projects read does not let the user create', async () => {
      const w = await setup();
      const error = await errorOf(
        createChart(db(), at(w.wide), {
          organisationId: w.organisationId,
          projectId: w.projectId,
          key: 'second',
          name: 'Second chart',
        }),
      );
      expect(error).toBeInstanceOf(AccessDeniedError);
      expect(error).toMatchObject({ permission: EDIT, scope: 'project' });
    });

    it('refuses the same user in another organisation, and in a soft-deleted project', async () => {
      const w = await setup();
      const other = await seedOrganisation(database);
      const foreign = await errorOf(
        listCharts(db(), at(w.wide), {
          organisationId: other.organisationId,
          projectId: other.projectId,
        }),
      );
      expect(foreign).toBeInstanceOf(AccessDeniedError);
      await db()
        .update(project)
        .set({ deletedAt: new Date() })
        .where(eq(project.id, w.secondProject));
      const deleted = await errorOf(
        listCharts(db(), at(w.wide), {
          organisationId: w.organisationId,
          projectId: w.secondProject,
        }),
      );
      expect(deleted).toBeInstanceOf(AccessDeniedError);
      // The live project is still reachable.
      expect(
        await listCharts(db(), at(w.wide), {
          organisationId: w.organisationId,
          projectId: w.projectId,
        }),
      ).toHaveLength(1);
    });
  },
);
