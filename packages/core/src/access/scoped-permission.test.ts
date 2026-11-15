import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { hasScopedPermission } from './scoped-permission.js';
import {
  ensurePermissions,
  grantOnOrganisation,
  grantOnProject,
  seedOrganisation,
  seedProject,
  seedUser,
} from './test-fixtures.js';

const KEY = 'budget:read';
const OTHER_KEY = 'budget:edit';

describe.each(testTargets)('hasScopedPermission on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    await ensurePermissions(database, [KEY, OTHER_KEY]);
  });
  afterAll(async () => {
    await cleanup();
  });

  /** An organisation with two projects, a user on each scope, and one on neither. */
  async function setup() {
    const org = await seedOrganisation(database);
    const otherProjectId = await seedProject(database, org.organisationId);
    const onProject = await seedUser(database);
    await grantOnProject(
      database,
      org.organisationId,
      org.projectId,
      onProject,
      [KEY],
    );
    const inOrganisation = await seedUser(database);
    await grantOnOrganisation(
      database,
      org.organisationId,
      inOrganisation,
      'admin',
      [KEY],
    );
    const nowhere = await seedUser(database);
    return { ...org, otherProjectId, onProject, inOrganisation, nowhere };
  }

  const check = (
    w: Awaited<ReturnType<typeof setup>>,
    userId: string,
    projectId: string | null,
    key = KEY,
  ) =>
    hasScopedPermission(
      database.db,
      userId,
      { organisationId: w.organisationId, projectId },
      key,
    );

  describe('with a project', () => {
    it('is true for a role on that project holding the key', async () => {
      const w = await setup();
      expect(await check(w, w.onProject, w.projectId)).toBe(true);
    });

    it('is false for another key, another project, no role and an organisation role', async () => {
      const w = await setup();
      expect(await check(w, w.onProject, w.projectId, OTHER_KEY)).toBe(false);
      expect(await check(w, w.onProject, w.otherProjectId)).toBe(false);
      expect(await check(w, w.nowhere, w.projectId)).toBe(false);
      expect(await check(w, w.inOrganisation, w.projectId)).toBe(false);
    });
  });

  describe('without a project, in the organisation', () => {
    it('is true for an organisation role holding the key', async () => {
      const w = await setup();
      expect(await check(w, w.inOrganisation, null)).toBe(true);
    });

    it('is false for another key, no role and a project role', async () => {
      const w = await setup();
      expect(await check(w, w.inOrganisation, null, OTHER_KEY)).toBe(false);
      expect(await check(w, w.nowhere, null)).toBe(false);
      expect(await check(w, w.onProject, null)).toBe(false);
    });

    it('is false in another organisation', async () => {
      const w = await setup();
      const other = await seedOrganisation(database);
      expect(
        await hasScopedPermission(
          database.db,
          w.inOrganisation,
          { organisationId: other.organisationId, projectId: null },
          KEY,
        ),
      ).toBe(false);
    });
  });
});
