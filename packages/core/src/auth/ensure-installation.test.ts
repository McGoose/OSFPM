import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { auditEvent, installation } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { getServerId } from '../installation/server-id.js';
import { ensureInstallation } from './ensure-installation.js';
import { AUTH_AUDIT } from './shared.js';

/** Matches a UUIDv7, the form of every server id. */
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const T0 = new Date('2026-03-02T09:00:00.000Z');
const FIRST_URL = 'https://films.example.test';

describe.each(testTargets)('ensureInstallation on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
  });
  afterAll(async () => {
    await cleanup();
  });
  // The single-row index makes the row global, so every test starts without one.
  beforeEach(async () => {
    await database.db.delete(installation);
  });

  const db = () => database.db;
  const rows = () => db().select().from(installation);
  const createdEvents = async () =>
    (await db().select().from(auditEvent)).filter(
      (event) => event.category === AUTH_AUDIT.installationCreated,
    );

  it('makes the row, with a new UUIDv7 id and the base URL, and says it made it', async () => {
    const result = await ensureInstallation(db(), {
      baseUrl: FIRST_URL,
      now: T0,
    });
    expect(result.created).toBe(true);
    expect(result.id).toMatch(UUID_V7);
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      id: result.id,
      baseUrl: FIRST_URL,
      setupCompletedAt: null,
    });
    expect(row!.createdAt).toEqual(T0);
    // `getServerId` is what every other service asks, and works from now on.
    expect(await getServerId(db())).toBe(result.id);
  });

  it('leaves a row that exists exactly as it is: the same id, the first base URL, nothing made', async () => {
    const first = await ensureInstallation(db(), {
      baseUrl: FIRST_URL,
      now: T0,
    });
    const again = await ensureInstallation(db(), {
      baseUrl: 'https://moved.example.test',
      now: new Date(T0.getTime() + 60_000),
    });
    expect(again).toEqual({ id: first.id, created: false });
    const [row, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ id: first.id, baseUrl: FIRST_URL });
    expect(row!.createdAt).toEqual(T0);
  });

  it('never replaces a row, one whose setup is complete included', async () => {
    const first = await ensureInstallation(db(), {
      baseUrl: FIRST_URL,
      now: T0,
    });
    await db().update(installation).set({ setupCompletedAt: T0 });
    const again = await ensureInstallation(db(), {
      baseUrl: FIRST_URL,
      now: T0,
    });
    expect(again).toEqual({ id: first.id, created: false });
    expect((await rows())[0]!.setupCompletedAt).toEqual(T0);
  });

  it('writes one auth.installation-created event, from the system, about the installation, with no details', async () => {
    const before = (await createdEvents()).length;
    const { id } = await ensureInstallation(db(), {
      baseUrl: FIRST_URL,
      now: T0,
    });
    await ensureInstallation(db(), { baseUrl: FIRST_URL, now: T0 });
    const events = (await createdEvents()).filter(
      (event) => event.targetId === id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'create',
      actorType: 'system',
      actorId: null,
      targetType: 'installation',
      targetId: id,
      details: null,
      organisationId: null,
    });
    expect(events[0]!.occurredAt).toEqual(T0);
    expect((await createdEvents()).length).toBe(before + 1);
    // The base URL is not an audit detail.
    expect(JSON.stringify(events)).not.toContain(FIRST_URL);
  });

  it('agrees on one id when several servers start at once: one row, one event, one call that made it', async () => {
    const before = (await createdEvents()).length;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        db().transaction((tx) =>
          ensureInstallation(tx, { baseUrl: FIRST_URL, now: T0 }),
        ),
      ),
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
    expect((await createdEvents()).length).toBe(before + 1);
  });
});
