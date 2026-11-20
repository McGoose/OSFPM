import { and, asc, eq, inArray } from 'drizzle-orm';
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
  type SeedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  account,
  accountChart,
  auditEvent,
  changeEvent,
  changeSeq,
  permission,
  type OrgRole,
} from '../db/schema/index.js';
import {
  createMigratedDatabase,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';
import {
  RecordStateError,
  RecordWriteError,
  VersionConflictError,
} from '../db/write.js';
import {
  ACCOUNT_PERMISSIONS,
  ACCOUNTS_EDIT_PERMISSION,
  ACCOUNTS_READ_PERMISSION,
} from './permissions.js';
import {
  AccountHasChildrenError,
  AccountInputError,
  addAccount,
  copyChartToProject,
  createChart,
  getChart,
  listCharts,
  removeAccount,
  removeChart,
  updateAccount,
  updateChart,
  type AccountChartRow,
  type AccountContext,
  type AccountInput,
  type AccountRow,
} from './service.js';

// The permission keys are stored in role grants, so they are written out here
// instead of being taken from the constants under test.
const READ = 'accounts:read';
const EDIT = 'accounts:edit';

const NOW = new Date(Date.UTC(2026, 1, 1, 12));
const at = (userId: string): AccountContext => ({
  userId,
  originServer: ORIGIN,
  clock: () => NOW,
});

describe('account permissions', () => {
  it('are the two keys of the accounts module, and grant no sensitive data', () => {
    expect([ACCOUNTS_READ_PERMISSION, ACCOUNTS_EDIT_PERMISSION]).toEqual([
      READ,
      EDIT,
    ]);
    expect(ACCOUNT_PERMISSIONS.map((p) => p.key).sort()).toEqual(
      [EDIT, READ].sort(),
    );
    for (const p of ACCOUNT_PERMISSIONS) {
      expect(p.module).toBe('accounts');
      expect(p.grantsSensitive).toBe(false);
    }
  });
});

describe.each(testTargets)('charts of accounts on $name', (target) => {
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

  type World = SeedOrganisation & {
    // On the project.
    projectManager: string; // read, edit
    projectReader: string; // read
    projectEditor: string; // edit only
    // In the organisation. The tier grants nothing; the linked role does.
    orgManager: string; // read, edit
    orgReader: string; // read
    orgEditor: string; // edit only
    // Reads the organisation's templates and edits the project: may copy.
    copier: string;
    outsider: string;
  };

  async function setup(): Promise<World> {
    const org = await seedOrganisation(database);
    const onProject = async (keys: string[]) => {
      const userId = await seedUser(database);
      await grantOnProject(
        database,
        org.organisationId,
        org.projectId,
        userId,
        keys,
      );
      return userId;
    };
    const inOrganisation = async (tier: OrgRole, keys: string[]) => {
      const userId = await seedUser(database);
      await grantOnOrganisation(
        database,
        org.organisationId,
        userId,
        tier,
        keys,
      );
      return userId;
    };
    const copier = await inOrganisation('supervisor', [READ]);
    await grantOnProject(database, org.organisationId, org.projectId, copier, [
      EDIT,
    ]);
    return {
      ...org,
      projectManager: await onProject([READ, EDIT]),
      projectReader: await onProject([READ]),
      projectEditor: await onProject([EDIT]),
      orgManager: await inOrganisation('owner', [READ, EDIT]),
      orgReader: await inOrganisation('member', [READ]),
      orgEditor: await inOrganisation('guest', [EDIT]),
      copier,
      outsider: await seedUser(database),
    };
  }

  const chartsIn = (organisationId: string) =>
    db()
      .select()
      .from(accountChart)
      .where(eq(accountChart.organisationId, organisationId))
      .orderBy(asc(accountChart.id));
  const accountsIn = (organisationId: string) =>
    db()
      .select()
      .from(account)
      .where(eq(account.organisationId, organisationId))
      .orderBy(asc(account.id));
  const eventsIn = (organisationId: string) =>
    db()
      .select()
      .from(changeEvent)
      .where(
        and(
          eq(changeEvent.organisationId, organisationId),
          inArray(changeEvent.entityType, ['account_chart', 'account']),
        ),
      )
      .orderBy(asc(changeEvent.seq));
  const sequencesIn = (organisationId: string) =>
    db()
      .select()
      .from(changeSeq)
      .where(eq(changeSeq.organisationId, organisationId))
      .orderBy(asc(changeSeq.projectId));
  const auditIn = (organisationId: string) =>
    db()
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.organisationId, organisationId));

  /**
   * Everything a call could write for the organisation: the rows, the change
   * events and the change counters. A refused call must leave this unchanged.
   */
  const snapshot = async (w: World) => ({
    charts: await chartsIn(w.organisationId),
    accounts: await accountsIn(w.organisationId),
    events: await eventsIn(w.organisationId),
    sequences: await sequencesIn(w.organisationId),
  });

  /** The error a call fails with. Fails the test when the call succeeds. */
  const errorOf = (call: Promise<unknown>) =>
    call.then(
      () => {
        throw new Error('Expected the call to fail, but it succeeded');
      },
      (error: unknown) => error,
    );

  const denied = (permissionKey: string) => ({
    name: 'AccessDeniedError',
    permission: permissionKey,
  });

  /** What a denial tells the caller: the same for every reason a call by id is refused. */
  const shapeOf = (error: unknown) => {
    const found = error as AccessDeniedError;
    return {
      name: found.name,
      permission: found.permission,
      scope: found.scope,
      message: found.message,
    };
  };

  const templateIn = (
    w: World,
    overrides: Partial<Parameters<typeof createChart>[2]> = {},
  ) =>
    createChart(db(), at(w.orgManager), {
      organisationId: w.organisationId,
      key: 'standard',
      name: 'Standard chart',
      ...overrides,
    });

  const projectChartIn = (
    w: World,
    overrides: Partial<Parameters<typeof createChart>[2]> = {},
  ) =>
    createChart(db(), at(w.projectManager), {
      organisationId: w.organisationId,
      projectId: w.projectId,
      key: 'house',
      name: 'House chart',
      ...overrides,
    });

  /**
   * A template with a small tree, built through the service by the
   * organisation's manager:
   *
   *   1000 Above the line (not postable, sort 1)
   *   └ 1100 Crew
   *     ├ 1120 Sound (sort 1)
   *     └ 1110 Camera (sort 2, ledger code GL-1110)
   *   2000 Post-production (sort 2)
   *   9999 Retired, under 2000, removed again
   *
   * Tree order is 1000, 1100, 1120, 1110, 2000.
   */
  async function buildTemplate(w: World) {
    const template = await templateIn(w, {
      format: 'mmb',
      isDefault: true,
    });
    const add = (input: AccountInput) =>
      addAccount(db(), at(w.orgManager), template.id, input);
    const atl = await add({
      code: '1000',
      name: 'Above the line',
      isPostable: false,
      sortOrder: 1,
    });
    const crew = await add({ code: '1100', name: 'Crew', parentId: atl.id });
    const camera = await add({
      code: '1110',
      name: 'Camera',
      parentId: crew.id,
      glCode: 'GL-1110',
      sortOrder: 2,
    });
    const sound = await add({
      code: '1120',
      name: 'Sound',
      parentId: crew.id,
      sortOrder: 1,
    });
    const post = await add({
      code: '2000',
      name: 'Post-production',
      sortOrder: 2,
    });
    const retired = await add({
      code: '9999',
      name: 'Retired',
      parentId: post.id,
    });
    await removeAccount(db(), at(w.orgManager), retired.id, retired.version);
    return { template, atl, crew, camera, sound, post, retired };
  }

  const TREE_ORDER = ['1000', '1100', '1120', '1110', '2000'];

  /** Each account's code with its parent's code, in the order given. */
  const parentCodes = (rows: readonly AccountRow[]) => {
    const codeOf = new Map(rows.map((row) => [row.id, row.code]));
    return rows.map((row) => [
      row.code,
      row.parentId === null ? null : (codeOf.get(row.parentId) ?? '?'),
    ]);
  };

  describe('the permission catalogue', () => {
    it('is accepted by the permission table, and neither key grants sensitive data', async () => {
      const found = await db()
        .select({
          key: permission.key,
          module: permission.module,
          grantsSensitive: permission.grantsSensitive,
        })
        .from(permission)
        .where(eq(permission.module, 'accounts'))
        .orderBy(asc(permission.key));
      expect(found).toEqual([
        { key: EDIT, module: 'accounts', grantsSensitive: false },
        { key: READ, module: 'accounts', grantsSensitive: false },
      ]);
    });
  });

  describe('createChart', () => {
    it('writes an organisation template, checked in the organisation, with one change event in the organisation sequence', async () => {
      const w = await setup();
      const created = await templateIn(w, {
        key: 'house',
        name: 'House chart',
      });
      expect(created).toMatchObject({
        organisationId: w.organisationId,
        projectId: null,
        key: 'house',
        name: 'House chart',
        format: 'custom',
        isDefault: false,
        copiedFromChartId: null,
        visibility: 'project',
        retentionClass: 'financial-record',
        createdBy: w.orgManager,
        version: 1,
        accounts: [],
      });
      expect(
        (await eventsIn(w.organisationId)).map((e) => [
          e.entityType,
          e.action,
          e.projectId,
          e.seq,
        ]),
      ).toEqual([['account_chart', 'create', null, 1]]);
    });

    it('writes a project chart, checked on the project, with its change event in the project sequence', async () => {
      const w = await setup();
      const created = await projectChartIn(w, { format: 'mmb' });
      expect(created).toMatchObject({
        projectId: w.projectId,
        format: 'mmb',
        createdBy: w.projectManager,
      });
      expect(
        (await eventsIn(w.organisationId)).map((e) => [
          e.entityType,
          e.projectId,
          e.seq,
        ]),
      ).toEqual([['account_chart', w.projectId, 1]]);
    });

    it('makes the new chart the default of its scope and takes the default from the old one, leaving the other scope alone', async () => {
      const w = await setup();
      const projectDefault = await projectChartIn(w, { isDefault: true });
      const first = await templateIn(w, { key: 'first', isDefault: true });
      const second = await templateIn(w, { key: 'second', isDefault: true });
      expect(second.isDefault).toBe(true);
      const defaults = (await chartsIn(w.organisationId))
        .filter((chart) => chart.isDefault)
        .map((chart) => chart.id)
        .sort();
      expect(defaults).toEqual([projectDefault.id, second.id].sort());
      // The old default is changed in the same savepoint as the new chart, and
      // before it, as the unique index allows one default per scope.
      const inOrganisation = (await eventsIn(w.organisationId)).filter(
        (e) => e.projectId === null,
      );
      expect(inOrganisation.map((e) => [e.entityId, e.action, e.seq])).toEqual([
        [first.id, 'create', 1],
        [first.id, 'update', 2],
        [second.id, 'create', 3],
      ]);
      expect(inOrganisation[1]!.changedFields).toEqual(['is_default']);
    });

    it('does the same for a project’s default, and not for a chart that is not made the default', async () => {
      const w = await setup();
      const first = await projectChartIn(w, { key: 'first', isDefault: true });
      const second = await projectChartIn(w, { key: 'second' });
      expect(second.isDefault).toBe(false);
      const third = await projectChartIn(w, { key: 'third', isDefault: true });
      const found = await chartsIn(w.organisationId);
      expect(
        found.filter((chart) => chart.isDefault).map((chart) => chart.id),
      ).toEqual([third.id]);
      expect(found.find((chart) => chart.id === first.id)).toMatchObject({
        isDefault: false,
        version: 2,
      });
    });

    it('keeps the old default when the new chart is refused', async () => {
      const w = await setup();
      await templateIn(w, { key: 'house', isDefault: true });
      const before = await snapshot(w);
      const error = await errorOf(
        templateIn(w, { key: 'house', name: 'Again', isDefault: true }),
      );
      expect(error).toBeInstanceOf(RecordWriteError);
      expect(error).toMatchObject({
        code: SQLSTATE.uniqueViolation,
        constraint: 'account_chart_organisation_project_key_unique',
      });
      expect(await snapshot(w)).toEqual(before);
    });

    it('needs accounts:edit, and says which scope was missing without naming the organisation or the project', async () => {
      const w = await setup();
      const before = await snapshot(w);
      // Roles of the other scope grant nothing: the organisation's manager
      // cannot create a project chart, and the project's manager no template.
      for (const userId of [w.outsider, w.projectReader, w.orgManager]) {
        const error = await errorOf(
          createChart(db(), at(userId), {
            organisationId: w.organisationId,
            projectId: w.projectId,
            key: 'house',
            name: 'House chart',
          }),
        );
        expect(error).toBeInstanceOf(AccessDeniedError);
        expect(error).toMatchObject({ ...denied(EDIT), scope: 'project' });
        expect((error as Error).message).not.toContain(w.organisationId);
        expect((error as Error).message).not.toContain(w.projectId);
      }
      for (const userId of [w.outsider, w.orgReader, w.projectManager]) {
        const error = await errorOf(
          createChart(db(), at(userId), {
            organisationId: w.organisationId,
            key: 'house',
            name: 'House chart',
          }),
        );
        expect(error).toMatchObject({ ...denied(EDIT), scope: 'organisation' });
        expect((error as Error).message).not.toContain(w.organisationId);
      }
      expect(await snapshot(w)).toEqual(before);
    });

    it('lets the database refuse a key or a format that is not lower case and hyphens', async () => {
      const w = await setup();
      const badKey = await errorOf(templateIn(w, { key: 'Bad Key' }));
      expect(badKey).toBeInstanceOf(RecordWriteError);
      expect(badKey).toMatchObject({
        code: SQLSTATE.checkViolation,
        constraint: 'account_chart_key_check',
      });
      const badFormat = await errorOf(
        templateIn(w, { format: 'Pretty_Format' }),
      );
      expect(badFormat).toMatchObject({
        code: SQLSTATE.checkViolation,
        constraint: 'account_chart_format_check',
      });
      expect(await chartsIn(w.organisationId)).toEqual([]);
    });
  });

  /**
   * Removes a chart through the service, as the manager of its scope: the
   * project's for a project chart, the organisation's for a template.
   */
  const removeChartOf = (w: World, chart: AccountChartRow) =>
    removeChart(
      db(),
      at(chart.projectId === null ? w.orgManager : w.projectManager),
      chart.id,
      chart.version,
    );

  describe('updateChart', () => {
    it('changes the name, the key and the format, and bumps the version', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      await addAccount(db(), at(w.projectManager), chart.id, {
        code: '1000',
        name: 'Above the line',
      });
      const updated = await updateChart(
        db(),
        at(w.projectManager),
        chart.id,
        chart.version,
        {
          name: 'The Last Withdrawal budget',
          key: 'tlw-budget',
          format: 'mmb',
        },
      );
      expect(updated).toMatchObject({
        id: chart.id,
        name: 'The Last Withdrawal budget',
        key: 'tlw-budget',
        format: 'mmb',
        projectId: w.projectId,
        version: 2,
        updatedBy: w.projectManager,
      });
      expect(updated.accounts.map((a) => a.code)).toEqual(['1000']);
      const [event] = (await eventsIn(w.organisationId)).filter(
        (e) => e.entityType === 'account_chart' && e.action === 'update',
      );
      expect(event).toMatchObject({ projectId: w.projectId });
      expect([...event!.changedFields].sort()).toEqual([
        'format',
        'key',
        'name',
      ]);
    });

    it('makes the chart the default of its scope and takes the default from the old one in the same savepoint, leaving the other scope alone', async () => {
      const w = await setup();
      const first = await projectChartIn(w, { key: 'first', isDefault: true });
      const templateDefault = await templateIn(w, { isDefault: true });
      const second = await projectChartIn(w, { key: 'second' });
      const updated = await updateChart(
        db(),
        at(w.projectManager),
        second.id,
        second.version,
        { isDefault: true },
      );
      expect(updated.isDefault).toBe(true);
      const found = await chartsIn(w.organisationId);
      expect(
        found
          .filter((c) => c.isDefault)
          .map((c) => c.id)
          .sort(),
      ).toEqual([second.id, templateDefault.id].sort());
      expect(found.find((c) => c.id === first.id)).toMatchObject({
        isDefault: false,
        version: 2,
      });
      // The old default is cleared first, as the unique index allows one.
      expect(
        (await eventsIn(w.organisationId))
          .filter((e) => e.projectId === w.projectId)
          .map((e) => [e.entityId, e.action, e.seq]),
      ).toEqual([
        [first.id, 'create', 1],
        [second.id, 'create', 2],
        [first.id, 'update', 3],
        [second.id, 'update', 4],
      ]);
    });

    it('clears nothing when the chart already is the default', async () => {
      const w = await setup();
      const chart = await projectChartIn(w, { isDefault: true });
      const updated = await updateChart(
        db(),
        at(w.projectManager),
        chart.id,
        chart.version,
        { isDefault: true, name: 'Renamed' },
      );
      expect(updated).toMatchObject({
        isDefault: true,
        name: 'Renamed',
        version: 2,
      });
      const updates = (await eventsIn(w.organisationId)).filter(
        (e) => e.action === 'update',
      );
      expect(updates.map((e) => [e.entityId, e.changedFields])).toEqual([
        [chart.id, ['name']],
      ]);
    });

    it('can give up the default, which leaves the scope with none until another chart takes it', async () => {
      const w = await setup();
      const first = await projectChartIn(w, { key: 'first', isDefault: true });
      const second = await projectChartIn(w, { key: 'second' });
      const given = await updateChart(
        db(),
        at(w.projectManager),
        first.id,
        first.version,
        { isDefault: false },
      );
      expect(given.isDefault).toBe(false);
      expect(
        (await chartsIn(w.organisationId)).filter((c) => c.isDefault),
      ).toEqual([]);
      const taken = await updateChart(
        db(),
        at(w.projectManager),
        second.id,
        second.version,
        { isDefault: true },
      );
      expect(taken.isDefault).toBe(true);
    });

    it('keeps the old default when the update is refused, for a stale version and for a key already live', async () => {
      const w = await setup();
      await projectChartIn(w, { key: 'first', isDefault: true });
      const second = await projectChartIn(w, { key: 'second' });
      const before = await snapshot(w);
      const stale = await errorOf(
        updateChart(db(), at(w.projectManager), second.id, 9, {
          isDefault: true,
        }),
      );
      expect(stale).toBeInstanceOf(VersionConflictError);
      expect(await snapshot(w)).toEqual(before);
      const duplicate = await errorOf(
        updateChart(db(), at(w.projectManager), second.id, second.version, {
          key: 'first',
          isDefault: true,
        }),
      );
      expect(duplicate).toBeInstanceOf(RecordWriteError);
      expect(duplicate).toMatchObject({
        code: SQLSTATE.uniqueViolation,
        constraint: 'account_chart_organisation_project_key_unique',
      });
      expect(await snapshot(w)).toEqual(before);
    });

    it('lets the database refuse a key or a format that is not lower case and hyphens', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      const before = await snapshot(w);
      const badKey = await errorOf(
        updateChart(db(), at(w.projectManager), chart.id, chart.version, {
          key: 'Bad Key',
        }),
      );
      expect(badKey).toMatchObject({
        code: SQLSTATE.checkViolation,
        constraint: 'account_chart_key_check',
      });
      const badFormat = await errorOf(
        updateChart(db(), at(w.projectManager), chart.id, chart.version, {
          format: 'Pretty_Format',
        }),
      );
      expect(badFormat).toMatchObject({
        code: SQLSTATE.checkViolation,
        constraint: 'account_chart_format_check',
      });
      expect(await snapshot(w)).toEqual(before);
    });

    it('writes nothing for a change that alters no field', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      const before = await snapshot(w);
      const same = await updateChart(
        db(),
        at(w.projectManager),
        chart.id,
        chart.version,
        { name: chart.name },
      );
      expect(same.version).toBe(1);
      expect(await snapshot(w)).toEqual(before);
    });

    it('ignores keys the type does not list: the project and the template a chart was copied from cannot change', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const copy = await copyChartToProject(db(), at(w.copier), {
        sourceChartId: t.template.id,
        projectId: w.projectId,
      });
      const other = await projectChartIn(w, { key: 'other' });
      const hostile = JSON.parse(
        `{"name":"Renamed","projectId":null,"copiedFromChartId":"${other.id}",` +
          `"organisationId":"${newId()}","__proto__":{"key":"hacked"}}`,
      ) as Parameters<typeof updateChart>[4];
      const updated = await updateChart(
        db(),
        at(w.projectManager),
        copy.id,
        copy.version,
        hostile,
      );
      expect(updated).toMatchObject({
        name: 'Renamed',
        key: 'standard',
        projectId: w.projectId,
        copiedFromChartId: t.template.id,
        organisationId: w.organisationId,
      });
    });

    it('needs accounts:edit on the chart’s scope, and refuses an unknown or removed chart exactly like a forbidden one', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      const template = await templateIn(w);
      const removed = await projectChartIn(w, { key: 'removed' });
      await removeChartOf(w, removed);
      const before = await snapshot(w);
      const changes = { name: 'No' };
      for (const userId of [w.outsider, w.projectReader, w.orgManager]) {
        const error = await errorOf(
          updateChart(db(), at(userId), chart.id, chart.version, changes),
        );
        expect(error).toBeInstanceOf(AccessDeniedError);
        expect(error).toMatchObject(denied(EDIT));
        // The caller named the chart by id, so the scope is not revealed.
        expect((error as AccessDeniedError).scope).toBeUndefined();
      }
      for (const userId of [w.outsider, w.orgReader, w.projectManager]) {
        const error = await errorOf(
          updateChart(db(), at(userId), template.id, template.version, changes),
        );
        expect(error).toMatchObject(denied(EDIT));
      }
      const forbidden = await errorOf(
        updateChart(db(), at(w.outsider), chart.id, chart.version, changes),
      );
      for (const id of [newId(), removed.id]) {
        const error = await errorOf(
          updateChart(db(), at(w.projectManager), id, 1, changes),
        );
        expect(shapeOf(error)).toEqual(shapeOf(forbidden));
      }
      expect(await snapshot(w)).toEqual(before);
      expect(await auditIn(w.organisationId)).toEqual([]);
    });

    it('edits a template in the organisation', async () => {
      const w = await setup();
      const template = await templateIn(w);
      const updated = await updateChart(
        db(),
        at(w.orgManager),
        template.id,
        template.version,
        { name: 'House chart', isDefault: true },
      );
      expect(updated).toMatchObject({
        projectId: null,
        name: 'House chart',
        isDefault: true,
      });
      const events = (await eventsIn(w.organisationId)).filter(
        (e) => e.action === 'update',
      );
      expect(events.map((e) => e.projectId)).toEqual([null]);
    });
  });

  describe('removeChart', () => {
    it('removes the chart and all its live accounts, leaves an account that was already removed as it was, and keeps every row', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const storedBefore = await accountsIn(w.organisationId);
      const retiredBefore = storedBefore.find((a) => a.id === t.retired.id)!;
      expect(retiredBefore.deletedAt).not.toBeNull();
      const removed = await removeChart(
        db(),
        at(w.orgManager),
        t.template.id,
        t.template.version,
      );
      expect(removed).toMatchObject({
        id: t.template.id,
        version: 2,
        deletedBy: w.orgManager,
      });
      expect(removed.deletedAt).toEqual(NOW);
      const stored = await accountsIn(w.organisationId);
      expect(stored).toHaveLength(6);
      for (const row of stored) {
        expect(row.deletedAt).not.toBeNull();
        if (row.id === t.retired.id) expect(row).toEqual(retiredBefore);
        else expect(row).toMatchObject({ version: 2, deletedBy: w.orgManager });
      }
      expect(await chartsIn(w.organisationId)).toHaveLength(1);
    });

    it('writes the chart first and then each account in tree order, in the chart’s own sequence', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const codes = new Map(
        (await accountsIn(w.organisationId)).map((a) => [a.id, a.code]),
      );
      await removeChart(
        db(),
        at(w.orgManager),
        t.template.id,
        t.template.version,
      );
      const events = (await eventsIn(w.organisationId)).slice(-6);
      // The template's build used numbers 1 to 8.
      expect(
        events.map((e) => [
          e.entityType === 'account' ? codes.get(e.entityId) : e.entityType,
          e.action,
          e.seq,
          e.projectId,
        ]),
      ).toEqual([
        ['account_chart', 'delete', 9, null],
        ['1000', 'delete', 10, null],
        ['1100', 'delete', 11, null],
        ['1120', 'delete', 12, null],
        ['1110', 'delete', 13, null],
        ['2000', 'delete', 14, null],
      ]);
    });

    it('files the removal of a project chart in the project’s sequence and leaves the organisation’s alone', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      for (const code of ['1000', '1100']) {
        await addAccount(db(), at(w.projectManager), chart.id, {
          code,
          name: code,
        });
      }
      await removeChart(db(), at(w.projectManager), chart.id, chart.version);
      const events = await eventsIn(w.organisationId);
      expect(events.map((e) => [e.action, e.projectId, e.seq])).toEqual([
        ['create', w.projectId, 1],
        ['create', w.projectId, 2],
        ['create', w.projectId, 3],
        ['delete', w.projectId, 4],
        ['delete', w.projectId, 5],
        ['delete', w.projectId, 6],
      ]);
      expect(
        (await sequencesIn(w.organisationId)).map((s) => s.projectId),
      ).toEqual([w.projectId]);
    });

    it('leaves the chart, the accounts and the counter as they were when a write fails halfway', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const before = await snapshot(w);
      // A removal reads the clock three times: for `deleted_at`, for the row and
      // for its event. The ninth read fails: the chart and the first account are
      // removed, and the second account's row is in when its event cannot be.
      let reads = 0;
      const failing: AccountContext = {
        ...at(w.orgManager),
        clock: () => {
          reads += 1;
          if (reads > 8) throw new Error('The clock failed');
          return NOW;
        },
      };
      const error = await errorOf(
        removeChart(db(), failing, t.template.id, t.template.version),
      );
      expect(error).toBeInstanceOf(RecordWriteError);
      expect(reads).toBe(9);
      expect(await snapshot(w)).toEqual(before);
      // The counter went back with the rollback: a retry gets the next number.
      await removeChart(
        db(),
        at(w.orgManager),
        t.template.id,
        t.template.version,
      );
      const events = await eventsIn(w.organisationId);
      expect(events.at(-6)).toMatchObject({
        entityType: 'account_chart',
        action: 'delete',
        seq: 9,
      });
    });

    it('refuses a stale version before it touches an account', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const before = await snapshot(w);
      const error = await errorOf(
        removeChart(db(), at(w.orgManager), t.template.id, 5),
      );
      expect(error).toBeInstanceOf(VersionConflictError);
      expect(await snapshot(w)).toEqual(before);
    });

    it('frees the key and the default place, and leaves charts copied from the removed template as they were', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const copy = await copyChartToProject(db(), at(w.copier), {
        sourceChartId: t.template.id,
        projectId: w.projectId,
        makeDefault: true,
      });
      await removeChart(
        db(),
        at(w.orgManager),
        t.template.id,
        t.template.version,
      );
      const again = await templateIn(w, { isDefault: true });
      expect(again).toMatchObject({ key: 'standard', isDefault: true });
      expect(again.id).not.toBe(t.template.id);
      const kept = await getChart(db(), at(w.projectManager), copy.id);
      expect(kept).toMatchObject({
        isDefault: true,
        copiedFromChartId: t.template.id,
      });
      expect(kept.accounts.map((a) => a.code)).toEqual(TREE_ORDER);
      expect(
        (
          await listCharts(db(), at(w.orgReader), {
            organisationId: w.organisationId,
          })
        ).map((c) => c.id),
      ).toEqual([again.id]);
    });

    it('needs accounts:edit on the chart’s scope, and refuses an unknown or removed chart exactly like a forbidden one', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      const template = await templateIn(w);
      const before = await snapshot(w);
      for (const userId of [w.outsider, w.projectReader, w.orgManager]) {
        const error = await errorOf(
          removeChart(db(), at(userId), chart.id, chart.version),
        );
        expect(error).toBeInstanceOf(AccessDeniedError);
        expect(error).toMatchObject(denied(EDIT));
        expect((error as AccessDeniedError).scope).toBeUndefined();
      }
      for (const userId of [w.outsider, w.orgReader, w.projectManager]) {
        const error = await errorOf(
          removeChart(db(), at(userId), template.id, template.version),
        );
        expect(error).toMatchObject(denied(EDIT));
      }
      expect(await snapshot(w)).toEqual(before);
      const forbidden = await errorOf(
        removeChart(db(), at(w.outsider), chart.id, chart.version),
      );
      await removeChartOf(w, chart);
      for (const id of [newId(), chart.id]) {
        const error = await errorOf(
          removeChart(db(), at(w.projectManager), id, 2),
        );
        expect(shapeOf(error)).toEqual(shapeOf(forbidden));
      }
      expect(await auditIn(w.organisationId)).toEqual([]);
    });
  });

  describe('copyChartToProject', () => {
    const copyAs = (
      userId: string,
      w: World,
      sourceChartId: string,
      more: { key?: string; name?: string; makeDefault?: boolean } = {},
    ) =>
      copyChartToProject(db(), at(userId), {
        sourceChartId,
        projectId: w.projectId,
        ...more,
      });

    it('copies every live account with its tree, parents remapped to the copies, and records where the chart came from', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const copy = await copyAs(w.copier, w, t.template.id);
      expect(copy).toMatchObject({
        organisationId: w.organisationId,
        projectId: w.projectId,
        key: 'standard',
        name: 'Standard chart',
        format: 'mmb',
        isDefault: false,
        copiedFromChartId: t.template.id,
        retentionClass: 'financial-record',
        createdBy: w.copier,
        version: 1,
      });
      expect(copy.id).not.toBe(t.template.id);
      expect(copy.accounts.map((a) => a.code)).toEqual(TREE_ORDER);
      expect(parentCodes(copy.accounts)).toEqual([
        ['1000', null],
        ['1100', '1000'],
        ['1120', '1100'],
        ['1110', '1100'],
        ['2000', null],
      ]);
      expect(copy.accounts.find((a) => a.code === '1110')).toMatchObject({
        name: 'Camera',
        glCode: 'GL-1110',
        sortOrder: 2,
        isPostable: true,
      });
      expect(copy.accounts.find((a) => a.code === '1000')).toMatchObject({
        isPostable: false,
        sortOrder: 1,
      });
      // Every account is new, and belongs to the copy: no parent points back
      // into the template.
      const templateIds = new Set(
        (await accountsIn(w.organisationId))
          .filter((a) => a.chartId === t.template.id)
          .map((a) => a.id),
      );
      for (const row of copy.accounts) {
        expect(templateIds.has(row.id)).toBe(false);
        expect(row.chartId).toBe(copy.id);
        expect(row.createdBy).toBe(w.copier);
        expect(row.version).toBe(1);
        if (row.parentId !== null) {
          expect(templateIds.has(row.parentId)).toBe(false);
        }
      }
      // The removed account is not copied, and the template is as it was.
      expect(copy.accounts.map((a) => a.code)).not.toContain('9999');
      const template = await getChart(db(), at(w.orgManager), t.template.id);
      expect(template.accounts.map((a) => a.code)).toEqual(TREE_ORDER);
      expect(template.isDefault).toBe(true);
    });

    it('is a copy and not a link: later changes to the template do not reach it', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const copy = await copyAs(w.copier, w, t.template.id);
      await updateAccount(
        db(),
        at(w.orgManager),
        t.camera.id,
        t.camera.version,
        {
          name: 'Camera department',
        },
      );
      await addAccount(db(), at(w.orgManager), t.template.id, {
        code: '3000',
        name: 'Contingency',
      });
      const after = await getChart(db(), at(w.projectManager), copy.id);
      expect(after.accounts.map((a) => a.code)).toEqual(TREE_ORDER);
      expect(after.accounts.map((a) => a.name)).not.toContain(
        'Camera department',
      );
    });

    it('copies a template that has no accounts', async () => {
      const w = await setup();
      const template = await templateIn(w);
      const copy = await copyAs(w.copier, w, template.id);
      expect(copy).toMatchObject({ copiedFromChartId: template.id });
      expect(copy.accounts).toEqual([]);
    });

    it('uses the key and the name it is given, and takes the project’s default from the old default chart when asked', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const old = await projectChartIn(w, { key: 'old', isDefault: true });
      const copy = await copyAs(w.copier, w, t.template.id, {
        key: 'tlw-budget',
        name: 'The Last Withdrawal budget',
        makeDefault: true,
      });
      expect(copy).toMatchObject({
        key: 'tlw-budget',
        name: 'The Last Withdrawal budget',
        isDefault: true,
      });
      const found = await chartsIn(w.organisationId);
      expect(found.find((c) => c.id === old.id)!.isDefault).toBe(false);
      // The template's own default is another scope, and stays.
      expect(
        found
          .filter((c) => c.isDefault)
          .map((c) => c.id)
          .sort(),
      ).toEqual([copy.id, t.template.id].sort());
    });

    it('leaves the project’s default alone unless asked', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const old = await projectChartIn(w, { key: 'old', isDefault: true });
      const copy = await copyAs(w.copier, w, t.template.id, { key: 'second' });
      expect(copy.isDefault).toBe(false);
      const found = await chartsIn(w.organisationId);
      expect(found.find((c) => c.id === old.id)).toMatchObject({
        isDefault: true,
        version: 1,
      });
    });

    it('needs accounts:edit on the project and accounts:read on the organisation, and does not say which scope it checked', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const before = await snapshot(w);
      // No edit on the project: the project is checked first.
      for (const userId of [
        w.outsider,
        w.projectReader,
        w.orgManager,
        w.orgReader,
      ]) {
        const error = await errorOf(copyAs(userId, w, t.template.id));
        expect(error).toBeInstanceOf(AccessDeniedError);
        expect(error).toMatchObject(denied(EDIT));
        expect((error as AccessDeniedError).scope).toBeUndefined();
      }
      // Edit on the project, but no read on the organisation: a project role
      // grants nothing in the organisation.
      for (const userId of [w.projectManager, w.projectEditor]) {
        const error = await errorOf(copyAs(userId, w, t.template.id));
        expect(error).toBeInstanceOf(AccessDeniedError);
        expect(error).toMatchObject(denied(READ));
        expect((error as AccessDeniedError).scope).toBeUndefined();
        expect((error as Error).message).not.toContain(w.projectId);
      }
      expect(await snapshot(w)).toEqual(before);
      expect(await auditIn(w.organisationId)).toEqual([]);
    });

    it('refuses a project that does not exist, or is in another organisation, exactly like a forbidden one', async () => {
      const w = await setup();
      const other = await setup();
      const t = await buildTemplate(w);
      const before = await snapshot(w);
      const forbidden = await errorOf(copyAs(w.outsider, w, t.template.id));
      for (const projectId of [newId(), other.projectId]) {
        const error = await errorOf(
          copyChartToProject(db(), at(w.copier), {
            sourceChartId: t.template.id,
            projectId,
          }),
        );
        expect(error).toBeInstanceOf(AccessDeniedError);
        expect(shapeOf(error)).toEqual(shapeOf(forbidden));
      }
      expect(await snapshot(w)).toEqual(before);
    });

    it('refuses a source that is not a live organisation template of the project’s organisation, with one message for every reason', async () => {
      const w = await setup();
      await buildTemplate(w);
      const projectChart = await projectChartIn(w, { key: 'mine' });
      const removed = await templateIn(w, { key: 'gone' });
      await removeChartOf(w, removed);
      const other = await setup();
      const otherTemplate = await templateIn(other);
      const before = await snapshot(w);
      const messages = new Set<string>();
      for (const sourceChartId of [
        projectChart.id,
        removed.id,
        otherTemplate.id,
        newId(),
      ]) {
        const error = await errorOf(copyAs(w.copier, w, sourceChartId));
        expect(error).toBeInstanceOf(AccountInputError);
        messages.add((error as Error).message);
      }
      expect(messages.size).toBe(1);
      expect(await snapshot(w)).toEqual(before);
    });

    it('leaves nothing behind, and uses no change sequence number, when a write fails halfway', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const old = await projectChartIn(w, { key: 'old', isDefault: true });
      const before = await snapshot(w);
      // Every write reads the clock twice, once for the row and once for its
      // event. The tenth read fails: the old default has been cleared, the copy
      // and its first two accounts are written, and the third account's row is
      // in when its event cannot be.
      let reads = 0;
      const failing: AccountContext = {
        ...at(w.copier),
        clock: () => {
          reads += 1;
          if (reads > 9) throw new Error('The clock failed');
          return NOW;
        },
      };
      const error = await errorOf(
        copyChartToProject(db(), failing, {
          sourceChartId: t.template.id,
          projectId: w.projectId,
          makeDefault: true,
        }),
      );
      expect(error).toBeInstanceOf(RecordWriteError);
      expect(reads).toBe(10);
      expect(await snapshot(w)).toEqual(before);
      // The project still has exactly one default, the old one.
      expect(
        (await chartsIn(w.organisationId))
          .filter((c) => c.projectId === w.projectId && c.isDefault)
          .map((c) => c.id),
      ).toEqual([old.id]);
      // The counter went back with the rollback: a retry gets the next numbers,
      // 1 being the old chart, then the copy and its five accounts.
      const retry = await copyAs(w.copier, w, t.template.id, { key: 'retry' });
      expect(retry.accounts).toHaveLength(5);
      expect(
        (await eventsIn(w.organisationId))
          .filter((e) => e.projectId === w.projectId)
          .map((e) => e.seq),
      ).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('leaves nothing behind when the key is already live in the project', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      await projectChartIn(w, { key: 'standard' });
      const before = await snapshot(w);
      const error = await errorOf(copyAs(w.copier, w, t.template.id));
      expect(error).toBeInstanceOf(RecordWriteError);
      expect(error).toMatchObject({
        code: SQLSTATE.uniqueViolation,
        constraint: 'account_chart_organisation_project_key_unique',
      });
      expect(await snapshot(w)).toEqual(before);
    });
  });

  describe('addAccount', () => {
    it('adds a top-level account and a child, with the defaults', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      const parent = await addAccount(db(), at(w.projectManager), chart.id, {
        code: '1000',
        name: 'Above the line',
      });
      expect(parent).toMatchObject({
        organisationId: w.organisationId,
        chartId: chart.id,
        parentId: null,
        code: '1000',
        name: 'Above the line',
        isPostable: true,
        glCode: null,
        sortOrder: 0,
        visibility: 'project',
        retentionClass: 'financial-record',
        createdBy: w.projectManager,
        version: 1,
      });
      const child = await addAccount(db(), at(w.projectManager), chart.id, {
        code: '1100',
        name: 'Crew',
        parentId: parent.id,
        isPostable: false,
        glCode: 'GL-1100',
        sortOrder: 3,
      });
      expect(child).toMatchObject({
        parentId: parent.id,
        isPostable: false,
        glCode: 'GL-1100',
        sortOrder: 3,
      });
    });

    it('adds to a template in the organisation', async () => {
      const w = await setup();
      const template = await templateIn(w);
      const added = await addAccount(db(), at(w.orgManager), template.id, {
        code: '1000',
        name: 'Above the line',
      });
      expect(added.chartId).toBe(template.id);
    });

    it('refuses a parent that is not a live account of the chart, with one message for every reason', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      const elsewhere = await projectChartIn(w, { key: 'elsewhere' });
      const inOtherChart = await addAccount(
        db(),
        at(w.projectManager),
        elsewhere.id,
        { code: '1000', name: 'Other chart' },
      );
      const removed = await addAccount(db(), at(w.projectManager), chart.id, {
        code: '2000',
        name: 'Removed',
      });
      await removeAccount(
        db(),
        at(w.projectManager),
        removed.id,
        removed.version,
      );
      const other = await setup();
      const otherChart = await templateIn(other);
      const inOtherOrganisation = await addAccount(
        db(),
        at(other.orgManager),
        otherChart.id,
        { code: '1000', name: 'Other organisation' },
      );
      const before = await snapshot(w);
      const messages = new Set<string>();
      for (const parentId of [
        inOtherChart.id,
        removed.id,
        inOtherOrganisation.id,
        newId(),
      ]) {
        const error = await errorOf(
          addAccount(db(), at(w.projectManager), chart.id, {
            code: '3000',
            name: 'Child',
            parentId,
          }),
        );
        expect(error).toBeInstanceOf(AccountInputError);
        messages.add((error as Error).message);
      }
      expect(messages.size).toBe(1);
      expect(await snapshot(w)).toEqual(before);
    });

    it('lets the database refuse a code that is live in the chart and an empty one', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      await addAccount(db(), at(w.projectManager), chart.id, {
        code: '1000',
        name: 'First',
      });
      const before = await snapshot(w);
      const duplicate = await errorOf(
        addAccount(db(), at(w.projectManager), chart.id, {
          code: '1000',
          name: 'Second',
        }),
      );
      expect(duplicate).toBeInstanceOf(RecordWriteError);
      expect(duplicate).toMatchObject({
        code: SQLSTATE.uniqueViolation,
        constraint: 'account_chart_id_code_unique',
      });
      const empty = await errorOf(
        addAccount(db(), at(w.projectManager), chart.id, {
          code: '',
          name: 'Empty',
        }),
      );
      expect(empty).toMatchObject({
        code: SQLSTATE.checkViolation,
        constraint: 'account_code_check',
      });
      expect(await snapshot(w)).toEqual(before);
    });

    it('creates a new account when a removed code is added again, and leaves the removed one removed', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      const first = await addAccount(db(), at(w.projectManager), chart.id, {
        code: '1000',
        name: 'First',
      });
      const removed = await removeAccount(
        db(),
        at(w.projectManager),
        first.id,
        first.version,
      );
      const again = await addAccount(db(), at(w.projectManager), chart.id, {
        code: '1000',
        name: 'Again',
      });
      expect(again.id).not.toBe(first.id);
      expect(again).toMatchObject({ code: '1000', name: 'Again', version: 1 });
      const stored = await accountsIn(w.organisationId);
      expect(stored.find((a) => a.id === first.id)!.deletedAt).toEqual(
        removed.deletedAt,
      );
      expect(
        (await getChart(db(), at(w.projectManager), chart.id)).accounts,
      ).toHaveLength(1);
    });

    it('needs accounts:edit on the chart’s scope, and roles of the other scope grant nothing', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      const template = await templateIn(w);
      const before = await snapshot(w);
      const input = { code: '1000', name: 'Above the line' };
      for (const userId of [w.outsider, w.projectReader, w.orgManager]) {
        const error = await errorOf(
          addAccount(db(), at(userId), chart.id, input),
        );
        expect(error).toBeInstanceOf(AccessDeniedError);
        expect(error).toMatchObject(denied(EDIT));
        // The caller named the chart by id, so the scope is not revealed.
        expect((error as AccessDeniedError).scope).toBeUndefined();
      }
      for (const userId of [w.outsider, w.orgReader, w.projectManager]) {
        const error = await errorOf(
          addAccount(db(), at(userId), template.id, input),
        );
        expect(error).toMatchObject(denied(EDIT));
      }
      expect(await snapshot(w)).toEqual(before);
    });

    it('refuses an unknown or removed chart exactly like a forbidden one', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      const removed = await projectChartIn(w, { key: 'removed' });
      await removeChartOf(w, removed);
      const input = { code: '1000', name: 'Above the line' };
      const forbidden = await errorOf(
        addAccount(db(), at(w.outsider), chart.id, input),
      );
      for (const chartId of [newId(), removed.id]) {
        const error = await errorOf(
          addAccount(db(), at(w.projectManager), chartId, input),
        );
        expect(shapeOf(error)).toEqual(shapeOf(forbidden));
      }
    });
  });

  describe('updateAccount', () => {
    /** A project chart holding 1000 > 1100 > 1110, a sibling 1120 under 1100, and 2000. */
    async function tree(w: World) {
      const chart = await projectChartIn(w);
      const add = (input: AccountInput) =>
        addAccount(db(), at(w.projectManager), chart.id, input);
      const root = await add({ code: '1000', name: 'Above the line' });
      const crew = await add({ code: '1100', name: 'Crew', parentId: root.id });
      const camera = await add({
        code: '1110',
        name: 'Camera',
        parentId: crew.id,
      });
      const sound = await add({
        code: '1120',
        name: 'Sound',
        parentId: crew.id,
      });
      const post = await add({ code: '2000', name: 'Post-production' });
      return { chart, root, crew, camera, sound, post };
    }
    const update = (
      w: World,
      row: AccountRow,
      changes: Parameters<typeof updateAccount>[4],
    ) =>
      updateAccount(db(), at(w.projectManager), row.id, row.version, changes);

    it('changes the fields it is given and bumps the version', async () => {
      const w = await setup();
      const t = await tree(w);
      const updated = await update(w, t.camera, {
        code: '1115',
        name: 'Camera department',
        isPostable: false,
        glCode: 'GL-1115',
        sortOrder: 4,
      });
      expect(updated).toMatchObject({
        id: t.camera.id,
        code: '1115',
        name: 'Camera department',
        isPostable: false,
        glCode: 'GL-1115',
        sortOrder: 4,
        parentId: t.crew.id,
        version: 2,
        updatedBy: w.projectManager,
      });
      const cleared = await update(w, updated, { glCode: null });
      expect(cleared.glCode).toBeNull();
    });

    it('moves an account under a sibling, to another branch, and to the top level', async () => {
      const w = await setup();
      const t = await tree(w);
      const underSibling = await update(w, t.camera, { parentId: t.sound.id });
      expect(underSibling.parentId).toBe(t.sound.id);
      const otherBranch = await update(w, underSibling, {
        parentId: t.post.id,
      });
      expect(otherBranch.parentId).toBe(t.post.id);
      const top = await update(w, otherBranch, { parentId: null });
      expect(top.parentId).toBeNull();
      const [, , last] = (await eventsIn(w.organisationId)).slice(-3);
      expect(last).toMatchObject({
        action: 'update',
        changedFields: ['parent_id'],
      });
    });

    it('refuses a change that would make an account its own ancestor', async () => {
      const w = await setup();
      const t = await tree(w);
      const before = await snapshot(w);
      const cycles: [AccountRow, string][] = [
        [t.crew, t.crew.id], // its own parent
        [t.root, t.crew.id], // under its child
        [t.root, t.camera.id], // under its grandchild
        [t.crew, t.camera.id], // under its child's child
      ];
      for (const [row, parentId] of cycles) {
        const error = await errorOf(update(w, row, { parentId }));
        expect(error).toBeInstanceOf(AccountInputError);
      }
      expect(await snapshot(w)).toEqual(before);
    });

    it('refuses a parent that is not a live account of the same chart', async () => {
      const w = await setup();
      const t = await tree(w);
      const elsewhere = await projectChartIn(w, { key: 'elsewhere' });
      const foreign = await addAccount(
        db(),
        at(w.projectManager),
        elsewhere.id,
        { code: '1000', name: 'Other chart' },
      );
      const removed = await addAccount(db(), at(w.projectManager), t.chart.id, {
        code: '3000',
        name: 'Removed',
      });
      await removeAccount(
        db(),
        at(w.projectManager),
        removed.id,
        removed.version,
      );
      const before = await snapshot(w);
      for (const parentId of [foreign.id, removed.id, newId()]) {
        const error = await errorOf(update(w, t.post, { parentId }));
        expect(error).toBeInstanceOf(AccountInputError);
      }
      expect(await snapshot(w)).toEqual(before);
    });

    it('never moves an account to another chart, and ignores keys the type does not list', async () => {
      const w = await setup();
      const t = await tree(w);
      const elsewhere = await projectChartIn(w, { key: 'elsewhere' });
      const hostile = JSON.parse(
        `{"name":"Renamed","chartId":"${elsewhere.id}","organisationId":"${newId()}",` +
          '"__proto__":{"code":"hacked"},"constructor":{"code":"hacked"}}',
      ) as Parameters<typeof updateAccount>[4];
      const updated = await update(w, t.post, hostile);
      expect(updated).toMatchObject({
        name: 'Renamed',
        code: '2000',
        chartId: t.chart.id,
        organisationId: w.organisationId,
      });
    });

    it('lets the database refuse a code that is live in the chart', async () => {
      const w = await setup();
      const t = await tree(w);
      const before = await snapshot(w);
      const error = await errorOf(update(w, t.post, { code: '1000' }));
      expect(error).toBeInstanceOf(RecordWriteError);
      expect(error).toMatchObject({
        code: SQLSTATE.uniqueViolation,
        constraint: 'account_chart_id_code_unique',
      });
      expect(await snapshot(w)).toEqual(before);
    });

    it('refuses a stale version, and writes nothing for a change that alters no field', async () => {
      const w = await setup();
      const t = await tree(w);
      const stale = await errorOf(
        updateAccount(db(), at(w.projectManager), t.post.id, 9, {
          name: 'Late',
        }),
      );
      expect(stale).toBeInstanceOf(VersionConflictError);
      const before = await snapshot(w);
      const same = await update(w, t.post, { name: t.post.name });
      expect(same.version).toBe(1);
      expect(await snapshot(w)).toEqual(before);
    });

    it('needs accounts:edit on the chart’s scope, and refuses an unknown, removed or forbidden account alike', async () => {
      const w = await setup();
      const t = await tree(w);
      const removed = await addAccount(db(), at(w.projectManager), t.chart.id, {
        code: '3000',
        name: 'Removed',
      });
      await removeAccount(
        db(),
        at(w.projectManager),
        removed.id,
        removed.version,
      );
      const before = await snapshot(w);
      const forbidden = await errorOf(
        updateAccount(db(), at(w.projectReader), t.post.id, 1, { name: 'No' }),
      );
      expect(forbidden).toBeInstanceOf(AccessDeniedError);
      expect(forbidden).toMatchObject(denied(EDIT));
      expect((forbidden as AccessDeniedError).scope).toBeUndefined();
      for (const [userId, id] of [
        [w.projectManager, newId()],
        [w.projectManager, removed.id],
        [w.orgManager, t.post.id], // the organisation's role is not the project's
      ] as const) {
        const error = await errorOf(
          updateAccount(db(), at(userId), id, 1, { name: 'No' }),
        );
        expect(shapeOf(error)).toEqual(shapeOf(forbidden));
      }
      expect(await snapshot(w)).toEqual(before);
    });

    it('edits an account of a template in the organisation', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const updated = await updateAccount(
        db(),
        at(w.orgManager),
        t.post.id,
        t.post.version,
        { name: 'Post' },
      );
      expect(updated.name).toBe('Post');
      const denial = await errorOf(
        updateAccount(db(), at(w.projectManager), t.post.id, 2, { name: 'No' }),
      );
      expect(denial).toMatchObject(denied(EDIT));
    });
  });

  describe('removeAccount', () => {
    it('removes a leaf by soft delete, and keeps the row', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      const row = await addAccount(db(), at(w.projectManager), chart.id, {
        code: '1000',
        name: 'Above the line',
      });
      const removed = await removeAccount(
        db(),
        at(w.projectManager),
        row.id,
        row.version,
      );
      expect(removed).toMatchObject({
        id: row.id,
        version: 2,
        deletedBy: w.projectManager,
      });
      expect(removed.deletedAt).toEqual(NOW);
      expect((await accountsIn(w.organisationId)).map((a) => a.id)).toEqual([
        row.id,
      ]);
      expect(
        (await getChart(db(), at(w.projectManager), chart.id)).accounts,
      ).toEqual([]);
    });

    it('refuses to remove an account with live children, as a RecordStateError that does not say it is already deleted', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const before = await snapshot(w);
      const error = await errorOf(
        removeAccount(db(), at(w.orgManager), t.crew.id, t.crew.version),
      );
      expect(error).toBeInstanceOf(RecordStateError);
      expect(error).toBeInstanceOf(AccountHasChildrenError);
      expect(error).toMatchObject({
        name: 'RecordStateError',
        entityType: 'account',
        entityId: t.crew.id,
        operation: 'delete',
      });
      expect((error as Error).message).toContain('live child accounts');
      expect((error as Error).message).not.toContain('already deleted');
      expect(await snapshot(w)).toEqual(before);
    });

    it('removes a parent once its children are removed, and counts only live children', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const as = at(w.orgManager);
      // 2000 has one child, 9999, which is already removed.
      await removeAccount(db(), as, t.post.id, t.post.version);
      for (const child of [t.camera, t.sound]) {
        await removeAccount(db(), as, child.id, child.version);
      }
      const crew = await removeAccount(db(), as, t.crew.id, t.crew.version);
      expect(crew.deletedAt).not.toBeNull();
    });

    it('refuses a stale version, and an account that is already removed', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      const row = await addAccount(db(), at(w.projectManager), chart.id, {
        code: '1000',
        name: 'Above the line',
      });
      const stale = await errorOf(
        removeAccount(db(), at(w.projectManager), row.id, 7),
      );
      expect(stale).toBeInstanceOf(VersionConflictError);
      await removeAccount(db(), at(w.projectManager), row.id, row.version);
      // A removed account looks like an unknown one.
      const again = await errorOf(
        removeAccount(db(), at(w.projectManager), row.id, 2),
      );
      expect(again).toMatchObject(denied(EDIT));
    });

    it('needs accounts:edit on the chart’s scope, and refuses an unknown account like a forbidden one', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      const row = await addAccount(db(), at(w.projectManager), chart.id, {
        code: '1000',
        name: 'Above the line',
      });
      const before = await snapshot(w);
      const forbidden = await errorOf(
        removeAccount(db(), at(w.projectReader), row.id, row.version),
      );
      expect(forbidden).toMatchObject(denied(EDIT));
      expect((forbidden as AccessDeniedError).scope).toBeUndefined();
      const unknown = await errorOf(
        removeAccount(db(), at(w.projectManager), newId(), 1),
      );
      expect(shapeOf(unknown)).toEqual(shapeOf(forbidden));
      expect(await snapshot(w)).toEqual(before);
    });
  });

  describe('getChart', () => {
    it('returns the live accounts in tree order: parents first, siblings by sort order and then code', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      const add = (input: AccountInput) =>
        addAccount(db(), at(w.projectManager), chart.id, input);
      // A flat sort by sort order and code would put A0 before B and A last.
      const a = await add({ code: 'A', name: 'A', sortOrder: 5 });
      await add({ code: 'B', name: 'B', sortOrder: 1 });
      await add({ code: 'A1', name: 'A1', parentId: a.id });
      const a0 = await add({ code: 'A0', name: 'A0', parentId: a.id });
      await add({ code: 'A0x', name: 'A0x', parentId: a0.id });
      const gone = await add({ code: 'C', name: 'C', sortOrder: 2 });
      await removeAccount(db(), at(w.projectManager), gone.id, gone.version);
      const view = await getChart(db(), at(w.projectManager), chart.id);
      expect(view).toMatchObject({ id: chart.id, key: 'house' });
      expect(view.accounts.map((row) => row.code)).toEqual([
        'B',
        'A',
        'A0',
        'A0x',
        'A1',
      ]);
    });

    it('needs accounts:read on the chart’s scope, and roles of the other scope grant nothing', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const chart = await projectChartIn(w, { key: 'mine' });
      await getChart(db(), at(w.projectReader), chart.id);
      await getChart(db(), at(w.projectManager), chart.id);
      await getChart(db(), at(w.orgReader), t.template.id);
      await getChart(db(), at(w.orgManager), t.template.id);
      for (const [userId, id] of [
        [w.outsider, chart.id],
        [w.projectEditor, chart.id], // edit alone does not read
        [w.orgReader, chart.id], // the organisation's role is not the project's
        [w.outsider, t.template.id],
        [w.orgEditor, t.template.id],
        [w.projectManager, t.template.id], // the project's role is not the organisation's
        [w.copier, chart.id], // reads templates, edits the project, but does not read it
      ] as const) {
        const error = await errorOf(getChart(db(), at(userId), id));
        expect(error).toBeInstanceOf(AccessDeniedError);
        expect(error).toMatchObject(denied(READ));
        expect((error as AccessDeniedError).scope).toBeUndefined();
      }
    });

    it('refuses an unknown or removed chart exactly like a forbidden one', async () => {
      const w = await setup();
      const chart = await projectChartIn(w);
      const removed = await projectChartIn(w, { key: 'removed' });
      await removeChartOf(w, removed);
      const forbidden = await errorOf(getChart(db(), at(w.outsider), chart.id));
      for (const id of [newId(), removed.id]) {
        const error = await errorOf(getChart(db(), at(w.projectManager), id));
        expect(shapeOf(error)).toEqual(shapeOf(forbidden));
      }
    });
  });

  describe('listCharts', () => {
    it('lists the organisation templates, or one project’s charts, by key, without removed charts or the other scope', async () => {
      const w = await setup();
      const second = await seedProject(database, w.organisationId);
      await grantOnProject(
        database,
        w.organisationId,
        second,
        w.projectManager,
        [READ, EDIT],
      );
      await templateIn(w, { key: 'b-template' });
      await templateIn(w, { key: 'a-template' });
      const removedTemplate = await templateIn(w, { key: 'c-template' });
      await removeChartOf(w, removedTemplate);
      await projectChartIn(w, { key: 'p-two' });
      await projectChartIn(w, { key: 'p-one' });
      const removedProjectChart = await projectChartIn(w, { key: 'p-gone' });
      await removeChartOf(w, removedProjectChart);
      await createChart(db(), at(w.projectManager), {
        organisationId: w.organisationId,
        projectId: second,
        key: 'other-project',
        name: 'Other project',
      });
      const keys = (rows: readonly AccountChartRow[]) =>
        rows.map((row) => row.key);
      expect(
        keys(
          await listCharts(db(), at(w.orgReader), {
            organisationId: w.organisationId,
          }),
        ),
      ).toEqual(['a-template', 'b-template']);
      expect(
        keys(
          await listCharts(db(), at(w.orgReader), {
            organisationId: w.organisationId,
            projectId: null,
          }),
        ),
      ).toEqual(['a-template', 'b-template']);
      expect(
        keys(
          await listCharts(db(), at(w.projectReader), {
            organisationId: w.organisationId,
            projectId: w.projectId,
          }),
        ),
      ).toEqual(['p-one', 'p-two']);
      // The charts come without accounts.
      const [first] = await listCharts(db(), at(w.orgReader), {
        organisationId: w.organisationId,
      });
      expect(first).not.toHaveProperty('accounts');
    });

    it('needs accounts:read on the scope it names, and says which scope that was', async () => {
      const w = await setup();
      const before = await snapshot(w);
      for (const userId of [w.outsider, w.projectEditor, w.orgManager]) {
        const error = await errorOf(
          listCharts(db(), at(userId), {
            organisationId: w.organisationId,
            projectId: w.projectId,
          }),
        );
        expect(error).toBeInstanceOf(AccessDeniedError);
        expect(error).toMatchObject({ ...denied(READ), scope: 'project' });
      }
      for (const userId of [w.outsider, w.orgEditor, w.projectManager]) {
        const error = await errorOf(
          listCharts(db(), at(userId), { organisationId: w.organisationId }),
        );
        expect(error).toMatchObject({ ...denied(READ), scope: 'organisation' });
      }
      expect(await snapshot(w)).toEqual(before);
    });
  });

  describe('change events', () => {
    const lastSeq = async (organisationId: string, projectId: string | null) =>
      (await sequencesIn(organisationId)).find((s) => s.projectId === projectId)
        ?.lastSeq;

    it('put the changes of a project chart in the project sequence and those of a template in the organisation sequence, each with its own numbering', async () => {
      const w = await setup();
      const template = await templateIn(w);
      const chart = await projectChartIn(w);
      const templateRoot = await addAccount(
        db(),
        at(w.orgManager),
        template.id,
        {
          code: '1000',
          name: 'Template root',
        },
      );
      const projectRoot = await addAccount(
        db(),
        at(w.projectManager),
        chart.id,
        {
          code: '1000',
          name: 'Project root',
        },
      );
      const templateChild = await addAccount(
        db(),
        at(w.orgManager),
        template.id,
        { code: '1100', name: 'Template child', parentId: templateRoot.id },
      );
      await updateAccount(
        db(),
        at(w.projectManager),
        projectRoot.id,
        projectRoot.version,
        { name: 'Renamed' },
      );
      await removeAccount(
        db(),
        at(w.orgManager),
        templateChild.id,
        templateChild.version,
      );
      const events = await eventsIn(w.organisationId);
      const summary = (projectId: string | null) =>
        events
          .filter((e) => e.projectId === projectId)
          .map((e) => [e.entityType, e.action, e.seq]);
      expect(summary(null)).toEqual([
        ['account_chart', 'create', 1],
        ['account', 'create', 2],
        ['account', 'create', 3],
        ['account', 'delete', 4],
      ]);
      expect(summary(w.projectId)).toEqual([
        ['account_chart', 'create', 1],
        ['account', 'create', 2],
        ['account', 'update', 3],
      ]);
      expect(events).toHaveLength(7);
      expect(await lastSeq(w.organisationId, null)).toBe(4);
      expect(await lastSeq(w.organisationId, w.projectId)).toBe(3);
    });

    it('put a copy’s chart and accounts in the project sequence, one event each, and leave the template’s sequence alone', async () => {
      const w = await setup();
      const t = await buildTemplate(w);
      const templateSeq = await lastSeq(w.organisationId, null);
      // The template: one chart, six accounts, one removal.
      expect(templateSeq).toBe(8);
      await copyChartToProject(db(), at(w.copier), {
        sourceChartId: t.template.id,
        projectId: w.projectId,
      });
      const inProject = (await eventsIn(w.organisationId)).filter(
        (e) => e.projectId === w.projectId,
      );
      expect(inProject.map((e) => [e.entityType, e.action, e.seq])).toEqual([
        ['account_chart', 'create', 1],
        ['account', 'create', 2],
        ['account', 'create', 3],
        ['account', 'create', 4],
        ['account', 'create', 5],
        ['account', 'create', 6],
      ]);
      expect(await lastSeq(w.organisationId, null)).toBe(templateSeq);
      expect(await lastSeq(w.organisationId, w.projectId)).toBe(6);
    });
  });
});
