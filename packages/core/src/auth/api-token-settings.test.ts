import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccessDeniedError } from '../access/access-denied-error.js';
import { readApiTokenSwitches } from '../access/api-token-switches.js';
import type { Database } from '../db/client.js';
import {
  apiToken,
  auditEvent,
  changeEvent,
  settingValue,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { getApiTokenSwitches, setApiTokenSwitches } from './api-tokens.js';
import { AuthInputError } from './errors.js';
import { AUTH_AUDIT } from './shared.js';
import {
  seedApiToken,
  seedTokenScene,
  type TokenScene,
} from './test-support.js';

/**
 * `setApiTokenSwitches`: the two organisation switches for personal API tokens, and
 * what turning one off does to the tokens (SC-10, decision D-68). Tokens are written
 * directly, as fixtures do; the service that makes them is tested in `api-tokens.test.ts`.
 */

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** A time no other test uses, so an event can be found by when it happened. */
let clock = 0;
const next = () => at((clock += 1) * MINUTE);

describe.each(testTargets)('setApiTokenSwitches on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scene: TokenScene;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    scene = await seedTokenScene(database, T0);
  });
  afterAll(async () => {
    await cleanup();
  });
  afterEach(async () => {
    await database.db.delete(apiToken);
    await database.db.delete(settingValue);
  });

  const db = () => database.db;
  const set = (
    userId: string,
    input: { personalTokens: boolean; sensitive: boolean },
    now: Date,
    organisationId = scene.organisationId,
  ) =>
    db().transaction((tx) =>
      setApiTokenSwitches(tx, { userId }, organisationId, input, now),
    );
  const switches = () => readApiTokenSwitches(db(), scene.organisationId);

  /** The audit events about a switch, at one moment. */
  const switchEvents = async (now: Date) =>
    (await db().select().from(auditEvent))
      .filter(
        (event) =>
          event.category === AUTH_AUDIT.apiTokenSwitchChanged &&
          event.occurredAt.getTime() === now.getTime(),
      )
      .sort((a, b) =>
        String(a.details?.switch).localeCompare(String(b.details?.switch)),
      );
  /** The change events about a setting, at one moment. */
  const settingEvents = async (now: Date) =>
    (await db().select().from(changeEvent))
      .filter(
        (event) =>
          event.entityType === 'setting_value' &&
          event.occurredAt.getTime() === now.getTime(),
      )
      .sort((a, b) => a.seq - b.seq);

  it('needs api:manage in the organisation, and the refusal is the same for a stranger, a member without it and an organisation that does not exist', async () => {
    for (const [userId, organisationId] of [
      [scene.tokensId, scene.organisationId],
      [scene.plainId, scene.organisationId],
      [scene.strangerId, scene.organisationId],
      [scene.managerId, scene.otherOrganisationId],
      [scene.ownerId, '00000000-0000-7000-8000-000000000000'],
      [scene.ownerId, 'not-an-id'],
    ] as const) {
      const now = next();
      const refused = await set(
        userId,
        { personalTokens: true, sensitive: false },
        now,
        organisationId,
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(refused, `${userId} in ${organisationId}`).toBeInstanceOf(
        AccessDeniedError,
      );
      expect((refused as AccessDeniedError).permission).toBe('api:manage');
      expect((refused as AccessDeniedError).scope).toBeUndefined();
      expect(await settingEvents(now)).toEqual([]);
      expect(await switchEvents(now)).toEqual([]);
    }
    expect(await db().select().from(settingValue)).toEqual([]);
    expect(await switches()).toEqual({
      personalTokens: false,
      sensitive: false,
    });
  });

  it('lets a member who holds api:manage change them, though they cannot make a token', async () => {
    const result = await set(
      scene.managerId,
      { personalTokens: true, sensitive: false },
      next(),
    );
    expect(result.personalTokens).toBe(true);
  });

  describe('getApiTokenSwitches', () => {
    const read = (userId: string, organisationId = scene.organisationId) =>
      db().transaction((tx) =>
        getApiTokenSwitches(tx, { userId }, organisationId),
      );

    it('needs api:manage too, and the refusal is the same for a stranger, a member without it and an organisation that does not exist', async () => {
      for (const [userId, organisationId] of [
        [scene.tokensId, scene.organisationId],
        [scene.plainId, scene.organisationId],
        [scene.strangerId, scene.organisationId],
        [scene.managerId, scene.otherOrganisationId],
        [scene.ownerId, '00000000-0000-7000-8000-000000000000'],
        [scene.ownerId, 'not-an-id'],
      ] as const) {
        const refused = await read(userId, organisationId).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(refused, `${userId} in ${organisationId}`).toBeInstanceOf(
          AccessDeniedError,
        );
        expect((refused as AccessDeniedError).permission).toBe('api:manage');
        expect((refused as AccessDeniedError).scope).toBeUndefined();
      }
    });

    it('answers both off for an organisation that has never set them, and then what was set', async () => {
      expect(await read(scene.managerId)).toEqual({
        personalTokens: false,
        sensitive: false,
      });
      await set(
        scene.ownerId,
        { personalTokens: true, sensitive: true },
        next(),
      );
      expect(await read(scene.managerId)).toEqual({
        personalTokens: true,
        sensitive: true,
      });
      await set(
        scene.ownerId,
        { personalTokens: false, sensitive: false },
        next(),
      );
      expect(await read(scene.managerId)).toEqual({
        personalTokens: false,
        sensitive: false,
      });
    });
  });

  it('turns tokens on with one setting row, one change event and one audit event, and the reader sees it', async () => {
    const now = next();
    const result = await set(
      scene.ownerId,
      { personalTokens: true, sensitive: false },
      now,
    );
    expect(result).toEqual({
      personalTokens: true,
      sensitive: false,
      revoked: 0,
    });
    expect(await switches()).toEqual({
      personalTokens: true,
      sensitive: false,
    });

    const rows = await db().select().from(settingValue);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organisationId: scene.organisationId,
      ownerOrgId: scene.organisationId,
      layer: 'org',
      projectId: null,
      key: 'api.personal-tokens',
      value: true,
      version: 1,
      createdBy: scene.ownerId,
    });
    const changes = await settingEvents(now);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      organisationId: scene.organisationId,
      projectId: null,
      action: 'create',
      actorType: 'user',
      actorId: scene.ownerId,
      entityId: rows[0]!.id,
    });
    const events = await switchEvents(now);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organisationId: scene.organisationId,
      actorType: 'user',
      actorId: scene.ownerId,
      details: { switch: 'personal-tokens', enabled: true, revoked: 0 },
    });
  });

  it('turns both on in one call, with a setting row and an audit event for each', async () => {
    const now = next();
    await set(scene.ownerId, { personalTokens: true, sensitive: true }, now);
    expect(await switches()).toEqual({ personalTokens: true, sensitive: true });
    expect(await db().select().from(settingValue)).toHaveLength(2);
    expect((await switchEvents(now)).map((event) => event.details)).toEqual([
      { switch: 'personal-tokens', enabled: true, revoked: 0 },
      { switch: 'sensitive', enabled: true, revoked: 0 },
    ]);
  });

  it('refuses the sensitive switch on while tokens are off, and writes nothing', async () => {
    const now = next();
    const refused = await set(
      scene.ownerId,
      { personalTokens: false, sensitive: true },
      now,
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(refused).toBeInstanceOf(AuthInputError);
    expect((refused as AuthInputError).field).toBe('sensitive');
    expect(await db().select().from(settingValue)).toEqual([]);
    expect(await switchEvents(now)).toEqual([]);
  });

  it('refuses a value that is not a boolean', async () => {
    for (const input of [
      { personalTokens: 'yes', sensitive: false },
      { personalTokens: true, sensitive: 1 },
      { personalTokens: undefined, sensitive: false },
    ]) {
      await expect(
        set(scene.ownerId, input as never, next()),
      ).rejects.toBeInstanceOf(AuthInputError);
    }
  });

  describe('turning tokens off', () => {
    it('revokes every live token of the organisation at once, turns the sensitive switch off, and says how many', async () => {
      await set(
        scene.ownerId,
        { personalTokens: true, sensitive: true },
        next(),
      );
      const organisationId = scene.organisationId;
      const owners = await seedApiToken(
        database,
        organisationId,
        scene.ownerId,
      );
      const sensitive = await seedApiToken(
        database,
        organisationId,
        scene.medicalId,
        { access: 'write', sensitivePermissions: ['sensitive:read:medical'] },
      );
      const timed = await seedApiToken(
        database,
        organisationId,
        scene.tokensId,
        { expiresAt: at(30 * DAY), projectId: scene.projectId },
      );
      const alreadyRevoked = await seedApiToken(
        database,
        organisationId,
        scene.tokensId,
        {
          revokedAt: at(-DAY),
          revokeReason: 'manual',
          revokedBy: scene.tokensId,
        },
      );
      const expired = await seedApiToken(
        database,
        organisationId,
        scene.tokensId,
        { expiresAt: at(-DAY) },
      );
      const foreign = await seedApiToken(
        database,
        scene.otherOrganisationId,
        scene.strangerId,
      );

      const now = next();
      const result = await set(
        scene.ownerId,
        { personalTokens: false, sensitive: false },
        now,
      );
      expect(result).toEqual({
        personalTokens: false,
        sensitive: false,
        revoked: 3,
      });

      const stored = new Map(
        (await db().select().from(apiToken)).map((row) => [row.id, row]),
      );
      for (const token of [owners, sensitive, timed]) {
        expect(stored.get(token.id), token.id).toMatchObject({
          revokedAt: now,
          revokeReason: 'switch-off',
          revokedBy: scene.ownerId,
          version: 2,
        });
      }
      // What was not live is left as it was, and so is another organisation's token.
      expect(stored.get(alreadyRevoked.id)).toMatchObject({
        revokeReason: 'manual',
        version: 1,
      });
      expect(stored.get(expired.id)).toMatchObject({
        revokedAt: null,
        version: 1,
      });
      expect(stored.get(foreign.id)).toMatchObject({
        revokedAt: null,
        version: 1,
      });

      expect(await switches()).toEqual({
        personalTokens: false,
        sensitive: false,
      });
      // Both setting rows say false now, each with a change event of its own.
      const rows = await db().select().from(settingValue);
      expect(rows.map((row) => row.value)).toEqual([false, false]);
      expect((await settingEvents(now)).map((event) => event.action)).toEqual([
        'update',
        'update',
      ]);
      // One audit event for each switch that changed; the tokens are counted once.
      expect((await switchEvents(now)).map((event) => event.details)).toEqual([
        { switch: 'personal-tokens', enabled: false, revoked: 3 },
        { switch: 'sensitive', enabled: false, revoked: 0 },
      ]);
    });

    it('also revokes when only the tokens switch was on', async () => {
      await set(
        scene.ownerId,
        { personalTokens: true, sensitive: false },
        next(),
      );
      const token = await seedApiToken(
        database,
        scene.organisationId,
        scene.tokensId,
      );
      const now = next();
      const result = await set(
        scene.ownerId,
        { personalTokens: false, sensitive: false },
        now,
      );
      expect(result.revoked).toBe(1);
      expect(
        (await db().select().from(apiToken)).find((row) => row.id === token.id),
      ).toMatchObject({ revokeReason: 'switch-off' });
    });
  });

  describe('turning the sensitive switch off', () => {
    it('revokes only the tokens that have a sensitive scope', async () => {
      await set(
        scene.ownerId,
        { personalTokens: true, sensitive: true },
        next(),
      );
      const plain = await seedApiToken(
        database,
        scene.organisationId,
        scene.tokensId,
      );
      const scoped = await seedApiToken(
        database,
        scene.organisationId,
        scene.medicalId,
        { sensitivePermissions: ['sensitive:read:medical'] },
      );
      const scopedTwice = await seedApiToken(
        database,
        scene.organisationId,
        scene.ownerId,
        {
          access: 'write',
          projectId: scene.projectId,
          sensitivePermissions: [
            'sensitive:read:medical',
            'sensitive:edit:medical',
          ],
        },
      );

      const now = next();
      const result = await set(
        scene.ownerId,
        { personalTokens: true, sensitive: false },
        now,
      );
      expect(result).toEqual({
        personalTokens: true,
        sensitive: false,
        revoked: 2,
      });
      const stored = new Map(
        (await db().select().from(apiToken)).map((row) => [row.id, row]),
      );
      expect(stored.get(plain.id)).toMatchObject({
        revokedAt: null,
        version: 1,
      });
      for (const token of [scoped, scopedTwice]) {
        expect(stored.get(token.id), token.id).toMatchObject({
          revokedAt: now,
          revokeReason: 'switch-off',
          revokedBy: scene.ownerId,
        });
      }
      expect(await switches()).toEqual({
        personalTokens: true,
        sensitive: false,
      });
      // One audit event, for the switch that changed; the tokens switch did not.
      expect((await switchEvents(now)).map((event) => event.details)).toEqual([
        { switch: 'sensitive', enabled: false, revoked: 2 },
      ]);
    });
  });

  it('restores nothing when a switch is turned back on', async () => {
    await set(scene.ownerId, { personalTokens: true, sensitive: true }, next());
    const token = await seedApiToken(
      database,
      scene.organisationId,
      scene.medicalId,
      { sensitivePermissions: ['sensitive:read:medical'] },
    );
    await set(
      scene.ownerId,
      { personalTokens: false, sensitive: false },
      next(),
    );
    const now = next();
    const again = await set(
      scene.ownerId,
      { personalTokens: true, sensitive: true },
      now,
    );
    expect(again.revoked).toBe(0);
    expect(await switches()).toEqual({ personalTokens: true, sensitive: true });
    expect(
      (await db().select().from(apiToken)).find((row) => row.id === token.id),
    ).toMatchObject({ revokeReason: 'switch-off' });
    expect((await switchEvents(now)).map((event) => event.details)).toEqual([
      { switch: 'personal-tokens', enabled: true, revoked: 0 },
      { switch: 'sensitive', enabled: true, revoked: 0 },
    ]);
  });

  it('writes nothing for a call that changes nothing', async () => {
    await set(
      scene.ownerId,
      { personalTokens: true, sensitive: false },
      next(),
    );
    const before = {
      settings: (await db().select().from(settingValue)).length,
      changes: (await db().select().from(changeEvent)).length,
      audits: (await db().select().from(auditEvent)).length,
    };
    const now = next();
    const result = await set(
      scene.ownerId,
      { personalTokens: true, sensitive: false },
      now,
    );
    expect(result).toEqual({
      personalTokens: true,
      sensitive: false,
      revoked: 0,
    });
    expect({
      settings: (await db().select().from(settingValue)).length,
      changes: (await db().select().from(changeEvent)).length,
      audits: (await db().select().from(auditEvent)).length,
    }).toEqual(before);
    // Off to off, with no row, writes nothing either.
    await db().delete(settingValue);
    const off = next();
    await set(scene.ownerId, { personalTokens: false, sensitive: false }, off);
    expect(await db().select().from(settingValue)).toEqual([]);
    expect(await switchEvents(off)).toEqual([]);
  });

  it('keeps the setting rows in the organisation layer, one for each key, whatever the order of the calls', async () => {
    await set(scene.ownerId, { personalTokens: true, sensitive: true }, next());
    await set(
      scene.ownerId,
      { personalTokens: true, sensitive: false },
      next(),
    );
    await set(scene.ownerId, { personalTokens: true, sensitive: true }, next());
    const rows = await db().select().from(settingValue);
    expect(rows.map((row) => row.key).sort()).toEqual([
      'api.personal-tokens',
      'api.personal-tokens.sensitive',
    ]);
    expect(
      rows.every((row) => row.layer === 'org' && row.projectId === null),
    ).toBe(true);
  });
});
