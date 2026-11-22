import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { auditEvent, user } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';
import { RecordWriteError } from '../db/write.js';
import { AUTH_AUDIT } from './shared.js';
import { seedInstallation } from './test-support.js';
import { createUser } from './users.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');

describe.each(testTargets)('createUser on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let installationId: string;
  let counter = 0;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    installationId = await seedInstallation(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;

  /** An address no earlier test used. */
  const freshAddress = () => {
    counter += 1;
    return `user${counter}.demo@demopictures.example`;
  };

  const input = (
    overrides: Partial<Parameters<typeof createUser>[1]> = {},
  ) => ({
    email: freshAddress(),
    displayName: 'Quinn Example',
    locale: 'en-GB',
    timezone: 'Europe/London',
    now: T0,
    ...overrides,
  });

  const createdEvents = async () =>
    (await db().select().from(auditEvent)).filter(
      (event) => event.category === AUTH_AUDIT.userCreated,
    );
  const userCount = async () => (await db().select().from(user)).length;

  it('creates an active user and answers who they are', async () => {
    const email = freshAddress();
    const created = await createUser(db(), input({ email }));
    expect(created).toEqual({
      id: expect.any(String) as string,
      email,
      displayName: 'Quinn Example',
      locale: 'en-GB',
      timezone: 'Europe/London',
      status: 'active',
    });
    const [row] = await db().select().from(user).where(eq(user.id, created.id));
    expect(row).toMatchObject({
      originServer: installationId,
      status: 'active',
      version: 1,
      createdBy: null,
      updatedBy: null,
      deletedAt: null,
      lastLoginAt: null,
    });
    expect(row!.createdAt).toEqual(T0);
  });

  it('stores the address trimmed and in lower case, and the display name trimmed', async () => {
    const created = await createUser(
      db(),
      input({
        email: '  Mixed.Case.Unique@DemoPictures.Example \n',
        displayName: '  Quinn Example  ',
      }),
    );
    expect(created.email).toBe('mixed.case.unique@demopictures.example');
    expect(created.displayName).toBe('Quinn Example');
  });

  it('can create an invited user', async () => {
    const created = await createUser(db(), input({ status: 'invited' }));
    expect(created.status).toBe('invited');
  });

  it('refuses to create a disabled user, or a status it does not know', async () => {
    const before = await userCount();
    for (const status of ['disabled', 'deleted', '']) {
      await expect(
        createUser(db(), input({ status: status as 'active' })),
      ).rejects.toMatchObject({ name: 'AuthInputError', field: 'status' });
    }
    expect(await userCount()).toBe(before);
  });

  it('writes one auth.user-created event about the user, from the system by default, with no address in it', async () => {
    const email = freshAddress();
    const created = await createUser(db(), input({ email }));
    const events = (await createdEvents()).filter(
      (event) => event.targetId === created.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'create',
      actorType: 'system',
      actorId: null,
      targetType: 'user',
      details: { status: 'active' },
      organisationId: null,
    });
    expect(events[0]!.occurredAt).toEqual(T0);
    expect(JSON.stringify(events)).not.toContain(email);
  });

  it('records the user who made the account, when there is one', async () => {
    const maker = await createUser(db(), input());
    const created = await createUser(
      db(),
      input({ actor: { type: 'user', id: maker.id } }),
    );
    const [row] = await db().select().from(user).where(eq(user.id, created.id));
    expect(row).toMatchObject({ createdBy: maker.id, updatedBy: maker.id });
    const [event] = (await createdEvents()).filter(
      (found) => found.targetId === created.id,
    );
    expect(event).toMatchObject({ actorType: 'user', actorId: maker.id });
  });

  it('refuses an address that is taken, whatever its case, and its error says no more than the constraint', async () => {
    const email = freshAddress();
    await createUser(db(), input({ email }));
    const users = await userCount();
    const events = (await createdEvents()).length;
    const error = await createUser(
      db(),
      input({ email: email.toUpperCase() }),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RecordWriteError);
    expect(error).toMatchObject({
      code: SQLSTATE.uniqueViolation,
      constraint: 'user_email_unique',
    });
    expect((error as Error).message).not.toContain(email);
    // Nothing was written: no second user, and no event for the attempt.
    expect(await userCount()).toBe(users);
    expect((await createdEvents()).length).toBe(events);
  });

  it.each([
    ['not an address', 'not an address'],
    ['two @ signs', 'two@@signs.example'],
    ['an empty address', ''],
    ['an address over 320 characters', `${'a'.repeat(320)}@x.example`],
  ])('refuses %s, before anything is written', async (_name, value) => {
    const before = await userCount();
    await expect(
      createUser(db(), input({ email: value })),
    ).rejects.toMatchObject({ name: 'AuthInputError', field: 'email' });
    expect(await userCount()).toBe(before);
  });

  it('refuses an empty display name, and one that is only spaces', async () => {
    for (const displayName of ['', '   ']) {
      await expect(
        createUser(db(), input({ displayName })),
      ).rejects.toMatchObject({ name: 'AuthInputError', field: 'displayName' });
    }
  });

  it('refuses before the installation row exists, and writes nothing', async () => {
    const empty = await createMigratedDatabase(target);
    try {
      await expect(
        createUser(empty.database.db, input()),
      ).rejects.toMatchObject({
        name: 'AuthStateError',
        reason: 'installation-missing',
      });
      expect(await empty.database.db.select().from(user)).toEqual([]);
    } finally {
      await empty.cleanup();
    }
  });
});
