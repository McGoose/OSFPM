import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  base,
  ORIGIN,
  seedOrganisation,
  seedUser,
  type SeedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { changeEvent, contract } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { insertRecord, updateRecord, type WriteContext } from '../db/write.js';

const NOW = new Date(Date.UTC(2026, 1, 1, 12));

describe.each(testTargets)('contract change events on $name', (target) => {
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

  const eventsOf = (contractId: string) =>
    db()
      .select()
      .from(changeEvent)
      .where(
        and(
          eq(changeEvent.entityType, 'contract'),
          eq(changeEvent.entityId, contractId),
        ),
      )
      .orderBy(asc(changeEvent.seq));

  const newContract = () =>
    insertRecord(
      db(),
      contract,
      {
        ...base(org.organisationId),
        projectId: org.projectId,
        kind: 'cast-contract',
        title: 'Lead actor agreement',
        status: 'negotiating',
        currency: 'GBP',
        totalValue: '1234567.8900',
      },
      ctx,
    );

  it('records that the amount was set on create, but not the amount', async () => {
    const created = await newContract();
    const [event] = await eventsOf(created.id);
    expect(event!.action).toBe('create');
    expect(event!.changedFields).toContain('total_value');
    expect(event!.after).not.toHaveProperty('total_value');
    // Currency is not an amount, and stays.
    expect(event!.after).toMatchObject({
      currency: 'GBP',
      title: 'Lead actor agreement',
    });
    expect(JSON.stringify(event)).not.toContain('1234567');
  });

  it('records that the amount changed on update, but neither the old nor the new amount', async () => {
    const created = await newContract();
    await updateRecord(
      db(),
      contract,
      created.id,
      created.version,
      { totalValue: '2000000.0000' },
      ctx,
    );
    const [, event] = await eventsOf(created.id);
    expect(event!.action).toBe('update');
    expect(event!.changedFields).toEqual(['total_value']);
    expect(event!.before).not.toHaveProperty('total_value');
    expect(event!.after).not.toHaveProperty('total_value');
    const text = JSON.stringify(event);
    expect(text).not.toContain('1234567');
    expect(text).not.toContain('2000000');
  });

  it('still records the old and new currency when it changes', async () => {
    const created = await newContract();
    await updateRecord(
      db(),
      contract,
      created.id,
      created.version,
      { currency: 'EUR' },
      ctx,
    );
    const [, event] = await eventsOf(created.id);
    expect(event!.changedFields).toEqual(['currency']);
    expect(event!.before).toEqual({ currency: 'GBP' });
    expect(event!.after).toEqual({ currency: 'EUR' });
  });
});
