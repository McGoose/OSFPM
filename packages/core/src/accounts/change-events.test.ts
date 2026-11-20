import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  base,
  ORIGIN,
  seedOrganisation,
  seedUser,
  type SeedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { account, accountChart, changeEvent } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  insertRecord,
  RecordWriteError,
  softDeleteRecord,
  updateRecord,
  type WriteContext,
} from '../db/write.js';

const NOW = new Date(Date.UTC(2026, 1, 1, 12));

/**
 * The accounts table has no `project_id`: the write helper finds the project
 * through the chart, and an organisation template has none. These tests write
 * through the helper directly, so they check the resolver on its own, apart
 * from the service.
 */
describe.each(testTargets)('account change events on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let org: SeedOrganisation;
  let ctx: WriteContext;
  const db = () => database.db;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    org = await seedOrganisation(database);
    ctx = {
      actor: { type: 'user', id: await seedUser(database) },
      originServer: ORIGIN,
      clock: () => NOW,
    };
  });
  afterAll(async () => {
    await cleanup();
  });

  const eventsOf = (entityId: string) =>
    db()
      .select()
      .from(changeEvent)
      .where(eq(changeEvent.entityId, entityId))
      .orderBy(asc(changeEvent.seq));

  const newChart = (projectId: string | null) =>
    insertRecord(
      db(),
      accountChart,
      {
        ...base(org.organisationId),
        projectId,
        key: `chart-${newId()}`,
        name: 'Standard chart',
      },
      ctx,
    );

  const newAccount = (chartId: string, code: string) =>
    insertRecord(
      db(),
      account,
      { ...base(org.organisationId), chartId, code, name: `Account ${code}` },
      ctx,
    );

  it('files an account of a project chart in the project’s sequence, and an account of a template in the organisation’s', async () => {
    const projectChart = await newChart(org.projectId);
    const template = await newChart(null);
    const inProject = await newAccount(projectChart.id, '1000');
    const inTemplate = await newAccount(template.id, '1000');
    const [projectEvent] = await eventsOf(inProject.id);
    const [templateEvent] = await eventsOf(inTemplate.id);
    expect(projectEvent).toMatchObject({
      entityType: 'account',
      action: 'create',
      organisationId: org.organisationId,
      projectId: org.projectId,
    });
    expect(templateEvent).toMatchObject({
      entityType: 'account',
      action: 'create',
      organisationId: org.organisationId,
      projectId: null,
    });
    // Each chart's own event is in the same sequence as its accounts, and the
    // account follows it.
    const [projectChartEvent] = await eventsOf(projectChart.id);
    const [templateChartEvent] = await eventsOf(template.id);
    expect(projectChartEvent!.projectId).toBe(org.projectId);
    expect(templateChartEvent!.projectId).toBeNull();
    expect(projectEvent!.seq).toBe(projectChartEvent!.seq + 1);
    expect(templateEvent!.seq).toBe(templateChartEvent!.seq + 1);
  });

  it('numbers each scope on its own: accounts in a template do not use the project’s numbers', async () => {
    const freshOrg = await seedOrganisation(database);
    const projectChart = await insertRecord(
      db(),
      accountChart,
      {
        ...base(freshOrg.organisationId),
        projectId: freshOrg.projectId,
        key: 'house',
        name: 'House chart',
      },
      ctx,
    );
    const template = await insertRecord(
      db(),
      accountChart,
      { ...base(freshOrg.organisationId), key: 'house', name: 'House chart' },
      ctx,
    );
    for (const code of ['1000', '1100', '1200']) {
      await insertRecord(
        db(),
        account,
        {
          ...base(freshOrg.organisationId),
          chartId: template.id,
          code,
          name: code,
        },
        ctx,
      );
    }
    await insertRecord(
      db(),
      account,
      {
        ...base(freshOrg.organisationId),
        chartId: projectChart.id,
        code: '1000',
        name: '1000',
      },
      ctx,
    );
    const events = await db()
      .select()
      .from(changeEvent)
      .where(
        and(
          eq(changeEvent.organisationId, freshOrg.organisationId),
          inArray(changeEvent.entityType, ['account_chart', 'account']),
        ),
      )
      .orderBy(asc(changeEvent.seq));
    const seqs = (projectId: string | null) =>
      events.filter((e) => e.projectId === projectId).map((e) => e.seq);
    expect(seqs(null)).toEqual([1, 2, 3, 4]);
    expect(seqs(freshOrg.projectId)).toEqual([1, 2]);
  });

  it('keeps an account’s later changes in the same scope: update and delete', async () => {
    for (const projectId of [org.projectId, null]) {
      const chart = await newChart(projectId);
      const row = await newAccount(chart.id, '1000');
      const updated = await updateRecord(
        db(),
        account,
        row.id,
        row.version,
        { name: 'Renamed' },
        ctx,
      );
      await softDeleteRecord(db(), account, row.id, updated.version, ctx);
      const events = await eventsOf(row.id);
      expect(events.map((e) => [e.action, e.projectId])).toEqual([
        ['create', projectId],
        ['update', projectId],
        ['delete', projectId],
      ]);
    }
  });

  it('stores the whole account in the create event, and only the changed field in an update', async () => {
    const chart = await newChart(org.projectId);
    const row = await newAccount(chart.id, '1000');
    await updateRecord(
      db(),
      account,
      row.id,
      row.version,
      { glCode: 'GL-1000' },
      ctx,
    );
    const [created, updated] = await eventsOf(row.id);
    expect(created!.after).toMatchObject({
      chart_id: chart.id,
      parent_id: null,
      code: '1000',
      is_postable: true,
      sort_order: 0,
      retention_class: 'financial-record',
    });
    expect(updated!.changedFields).toEqual(['gl_code']);
    expect(updated!.before).toEqual({ gl_code: null });
    expect(updated!.after).toEqual({ gl_code: 'GL-1000' });
  });

  it('refuses to move an account to another chart, because that could move it to another project', async () => {
    const first = await newChart(org.projectId);
    const second = await newChart(null);
    const row = await newAccount(first.id, '1000');
    await expect(
      updateRecord(
        db(),
        account,
        row.id,
        row.version,
        { chartId: second.id },
        ctx,
      ),
    ).rejects.toThrow('chartId cannot be changed on account');
    const [stored] = await db()
      .select()
      .from(account)
      .where(eq(account.id, row.id));
    expect(stored!.chartId).toBe(first.id);
    expect(await eventsOf(row.id)).toHaveLength(1);
  });

  it('writes no event for an account of a chart that does not exist', async () => {
    const id = newId();
    const error = await insertRecord(
      db(),
      account,
      {
        ...base(org.organisationId),
        id,
        chartId: newId(),
        code: '1000',
        name: 'Orphan',
      },
      ctx,
    ).then(
      () => {
        throw new Error('Expected the insert to fail');
      },
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(RecordWriteError);
    expect(await eventsOf(id)).toEqual([]);
  });
});
