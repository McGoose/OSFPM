import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncPermissions } from '../access/permission-sync.js';
import {
  grantOnProject,
  ORIGIN,
  seedOrganisation,
  seedUser,
  type SeedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  changeEvent,
  changeSeq,
  costLine,
  costLineScheme,
} from '../db/schema/index.js';
import { sensitiveColumns } from '../db/sensitive.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { COST_PERMISSIONS } from './permissions.js';
import {
  createCostLine,
  removeCostLine,
  removeCostLineScheme,
  setCostLineScheme,
  updateCostLine,
  type CostContext,
} from './service.js';
import { seedAccount, seedChart } from './test-fixtures.js';

const NOW = new Date(Date.UTC(2026, 1, 1, 12));

describe('the columns marked sensitive on the cost tables', () => {
  it('are the amounts, and not the currency or the rate', () => {
    expect([...sensitiveColumns(costLine)].sort()).toEqual([
      'amount',
      'amount_project_currency',
    ]);
    expect([...sensitiveColumns(costLineScheme)]).toEqual([
      'qualifying_amount',
    ]);
  });
});

/**
 * Cost lines have a `project_id`, and scheme tags find their project through
 * the line. These tests run the real service and then read the change log the
 * way someone who may read a project's changes would.
 */
describe.each(testTargets)('cost change events on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let org: SeedOrganisation;
  let accountId: string;
  let ctx: CostContext;
  const db = () => database.db;

  // Distinctive values, so a leak shows up as a plain substring. Each has a
  // decimal point, so none can occur by chance inside the hex digits of an id.
  const AMOUNT = '4217.3519';
  const RATE = '1.5';
  const PROJECT_AMOUNT = '6326.0279'; // 4217.3519 x 1.5, rounded
  const NEW_AMOUNT = '8888.7777';
  const NEW_PROJECT_AMOUNT = '13333.1666'; // 8888.7777 x 1.5, rounded
  const QUALIFYING = '3141.5926';
  const AMOUNTS = [
    AMOUNT,
    PROJECT_AMOUNT,
    NEW_AMOUNT,
    NEW_PROJECT_AMOUNT,
    QUALIFYING,
    '100.0000',
  ];

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    await syncPermissions(db(), COST_PERMISSIONS);
    org = await seedOrganisation(database);
    const userId = await seedUser(database);
    await grantOnProject(
      database,
      org.organisationId,
      org.projectId,
      userId,
      COST_PERMISSIONS.map((p) => p.key),
    );
    ctx = { userId, originServer: ORIGIN, clock: () => NOW };
    accountId = await seedAccount(
      database,
      org.organisationId,
      await seedChart(database, org.organisationId, {
        projectId: org.projectId,
      }),
    );
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

  const newLine = () =>
    createCostLine(db(), ctx, {
      organisationId: org.organisationId,
      projectId: org.projectId,
      stage: 'actual',
      sourceType: 'other',
      accountId,
      description: 'Camera hire',
      territory: 'GB',
      productionPhase: 'principal-photography',
      amount: AMOUNT,
      currency: 'USD',
      fxRate: RATE,
    });

  it('logs a create with the field names and no amount, and keeps the currency and the rate', async () => {
    const line = await newLine();
    const [event] = await eventsOf(line.id);
    expect(event).toMatchObject({
      entityType: 'cost_line',
      action: 'create',
      entityVersion: 1,
      organisationId: org.organisationId,
      projectId: org.projectId,
    });
    expect(event!.changedFields).toEqual(
      expect.arrayContaining([
        'amount',
        'amount_project_currency',
        'currency',
        'fx_rate',
      ]),
    );
    expect(event!.before).toBeNull();
    expect(event!.after).toMatchObject({
      currency: 'USD',
      fx_rate: '1.5000000000',
      description: 'Camera hire',
      stage: 'actual',
    });
    expect(Object.keys(event!.after!)).not.toContain('amount');
    expect(Object.keys(event!.after!)).not.toContain('amount_project_currency');
  });

  it('logs an update of the amount by name only, before and after', async () => {
    const line = await newLine();
    await updateCostLine(db(), ctx, line.id, 1, { amount: NEW_AMOUNT });
    const [, update] = await eventsOf(line.id);
    expect(update).toMatchObject({ action: 'update', entityVersion: 2 });
    expect(update!.changedFields.sort()).toEqual(
      ['amount', 'amount_project_currency'].sort(),
    );
    // Nothing else changed, so there is nothing left to show.
    expect(update!.before).toEqual({});
    expect(update!.after).toEqual({});
  });

  it('shows a change of the currency and the rate, which are not amounts, with their values', async () => {
    const line = await newLine();
    await updateCostLine(db(), ctx, line.id, 1, {
      currency: 'EUR',
      fxRate: '1.1',
    });
    const [, update] = await eventsOf(line.id);
    expect(update!.before).toEqual({
      currency: 'USD',
      fx_rate: '1.5000000000',
    });
    expect(update!.after).toEqual({ currency: 'EUR', fx_rate: '1.1000000000' });
    expect(update!.changedFields).toEqual(
      expect.arrayContaining([
        'currency',
        'fx_rate',
        'amount_project_currency',
      ]),
    );
  });

  it('logs a tag with a qualifying amount by name only', async () => {
    const line = await newLine();
    await setCostLineScheme(db(), ctx, line.id, 'uk-hetv', {
      status: 'qualifying',
      qualifyingAmount: QUALIFYING,
      reason: 'UK spend',
    });
    const [tag] = await db()
      .select()
      .from(costLineScheme)
      .where(eq(costLineScheme.costLineId, line.id));
    const [event] = await eventsOf(tag!.id);
    expect(event).toMatchObject({
      entityType: 'cost_line_scheme',
      action: 'create',
      projectId: org.projectId,
    });
    expect(event!.changedFields).toEqual(
      expect.arrayContaining(['qualifying_amount', 'status', 'scheme_key']),
    );
    expect(event!.after).toMatchObject({
      status: 'qualifying',
      scheme_key: 'uk-hetv',
      reason: 'UK spend',
    });
    expect(Object.keys(event!.after!)).not.toContain('qualifying_amount');
  });

  it('holds no amount anywhere in the log after a whole life of lines and tags', async () => {
    const fresh = await seedOrganisation(database);
    const user = await seedUser(database);
    await grantOnProject(
      database,
      fresh.organisationId,
      fresh.projectId,
      user,
      COST_PERMISSIONS.map((p) => p.key),
    );
    const own: CostContext = { ...ctx, userId: user };
    const freshAccount = await seedAccount(
      database,
      fresh.organisationId,
      await seedChart(database, fresh.organisationId, {
        projectId: fresh.projectId,
      }),
    );
    const line = await createCostLine(db(), own, {
      organisationId: fresh.organisationId,
      projectId: fresh.projectId,
      stage: 'actual',
      sourceType: 'other',
      accountId: freshAccount,
      description: 'Camera hire',
      territory: 'GB',
      productionPhase: 'principal-photography',
      amount: AMOUNT,
      currency: 'USD',
      fxRate: RATE,
    });
    const tag = await setCostLineScheme(db(), own, line.id, 'uk-hetv', {
      status: 'qualifying',
      qualifyingAmount: QUALIFYING,
    });
    await updateCostLine(db(), own, line.id, 1, { amount: NEW_AMOUNT });
    await setCostLineScheme(db(), own, line.id, 'uk-hetv', {
      status: 'qualifying',
      qualifyingAmount: '100',
    });
    await removeCostLineScheme(db(), own, line.id, 'uk-hetv', 2);
    await setCostLineScheme(db(), own, line.id, 'fr-credit', {
      status: 'qualifying',
      qualifyingAmount: QUALIFYING,
    });
    await removeCostLine(db(), own, line.id, 2);
    expect(tag.version).toBe(1);

    const events = await db()
      .select()
      .from(changeEvent)
      .where(
        and(
          eq(changeEvent.organisationId, fresh.organisationId),
          inArray(changeEvent.entityType, ['cost_line', 'cost_line_scheme']),
        ),
      );
    // Line: create, update, delete. Tags: uk-hetv create, update, delete;
    // fr-credit create and delete (with the line).
    expect(events).toHaveLength(8);
    const everything = JSON.stringify(events);
    for (const amount of AMOUNTS) {
      expect(everything, amount).not.toContain(amount);
    }
    // The names are there, so a reader can see that an amount changed.
    expect(events.flatMap((e) => e.changedFields)).toEqual(
      expect.arrayContaining(['amount', 'qualifying_amount']),
    );
  });

  describe('the project of each event', () => {
    it('files a tag in its line’s project, in the same sequence, after the line', async () => {
      const line = await newLine();
      await setCostLineScheme(db(), ctx, line.id, 'uk-hetv', {
        status: 'pending',
      });
      const [tag] = await db()
        .select()
        .from(costLineScheme)
        .where(eq(costLineScheme.costLineId, line.id));
      const [lineEvent] = await eventsOf(line.id);
      const [tagEvent] = await eventsOf(tag!.id);
      expect(lineEvent!.projectId).toBe(org.projectId);
      expect(tagEvent!.projectId).toBe(org.projectId);
      expect(tagEvent!.seq).toBe(lineEvent!.seq + 1);
    });

    it('files the tags removed with a line in the line’s project too, though the line is gone', async () => {
      const line = await newLine();
      await setCostLineScheme(db(), ctx, line.id, 'uk-hetv', {
        status: 'pending',
      });
      await setCostLineScheme(db(), ctx, line.id, 'fr-credit', {
        status: 'pending',
      });
      await removeCostLine(db(), ctx, line.id, 1);
      const tags = await db()
        .select()
        .from(costLineScheme)
        .where(eq(costLineScheme.costLineId, line.id));
      expect(tags).toHaveLength(2);
      for (const tag of tags) {
        const events = await eventsOf(tag.id);
        expect(events.map((e) => e.action)).toEqual(['create', 'delete']);
        expect(events.every((e) => e.projectId === org.projectId)).toBe(true);
      }
    });

    it('numbers cost changes in the project’s sequence and leaves the organisation’s alone', async () => {
      const fresh = await seedOrganisation(database);
      const user = await seedUser(database);
      await grantOnProject(
        database,
        fresh.organisationId,
        fresh.projectId,
        user,
        COST_PERMISSIONS.map((p) => p.key),
      );
      const freshAccount = await seedAccount(
        database,
        fresh.organisationId,
        await seedChart(database, fresh.organisationId, {
          projectId: fresh.projectId,
        }),
      );
      const own: CostContext = { ...ctx, userId: user };
      const before = await db()
        .select()
        .from(changeSeq)
        .where(eq(changeSeq.organisationId, fresh.organisationId));
      const line = await createCostLine(db(), own, {
        organisationId: fresh.organisationId,
        projectId: fresh.projectId,
        stage: 'budget',
        sourceType: 'other',
        accountId: freshAccount,
        description: 'Camera hire',
        territory: 'GB',
        productionPhase: 'pre-production',
        amount: '10',
        currency: 'GBP',
      });
      await setCostLineScheme(db(), own, line.id, 'uk-hetv', {
        status: 'pending',
      });
      const after = await db()
        .select()
        .from(changeSeq)
        .where(eq(changeSeq.organisationId, fresh.organisationId));
      const lastOf = (rows: typeof after, projectId: string | null) =>
        rows.find((r) => r.projectId === projectId)?.lastSeq ?? 0;
      expect(lastOf(after, fresh.projectId)).toBe(
        lastOf(before, fresh.projectId) + 2,
      );
      expect(lastOf(after, null)).toBe(lastOf(before, null));
    });
  });
});
