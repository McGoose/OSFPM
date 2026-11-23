import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { apiToken, auditEvent } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { createAccessReset, useAccessReset } from './access-reset.js';
import { AccessResetInvalidError } from './access-reset-errors.js';
import { ApiTokenInvalidError } from './api-token-errors.js';
import {
  authenticateApiToken,
  createApiToken,
  setApiTokenSwitches,
} from './api-tokens.js';
import { AUTH_AUDIT } from './shared.js';
import {
  seedApiToken,
  seedSession,
  seedTokenScene,
  type TokenScene,
} from './test-support.js';

/**
 * Using an admin reset link revokes every live personal API token of the person it
 * was made for, in the same transaction, and counts them in its audit event (SC-10,
 * decisions D-57 and D-68). A person whose access was reset must not keep a script
 * that still works.
 */

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(T0.getTime() + ms);

let clock = 0;
const next = () => at((clock += 1) * MINUTE);

describe.each(testTargets)(
  'an admin reset link and API tokens on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: TokenScene;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      scene = await seedTokenScene(database, T0);
      await database.db.transaction((tx) =>
        setApiTokenSwitches(
          tx,
          { userId: scene.ownerId },
          scene.organisationId,
          { personalTokens: true, sensitive: true },
          next(),
        ),
      );
    });
    afterAll(async () => {
      await cleanup();
    });
    afterEach(async () => {
      await database.db.delete(apiToken);
    });

    const db = () => database.db;
    const link = async (personId: string, now: Date, hours = 24) =>
      db().transaction((tx) =>
        createAccessReset(
          tx,
          { userId: scene.ownerId },
          scene.organisationId,
          personId,
          { expiresInHours: hours },
          now,
        ),
      );

    it('revokes every live token of the person, with the reason access-reset and nobody as the revoker, and counts them in its event', async () => {
      // The person holds no API permission now. Their tokens are fixtures, which is
      // what an earlier role of theirs could have left behind.
      const person = scene.plainId;
      const first = await seedApiToken(database, scene.organisationId, person);
      const second = await seedApiToken(
        database,
        scene.organisationId,
        person,
        {
          access: 'write',
          sensitivePermissions: ['sensitive:read:medical'],
          projectId: scene.projectId,
        },
      );
      const timed = await seedApiToken(database, scene.organisationId, person, {
        expiresAt: at(400 * DAY),
      });
      // Not live: revoked already, and expired.
      const revoked = await seedApiToken(
        database,
        scene.organisationId,
        person,
        {
          revokedAt: at(-DAY),
          revokeReason: 'manual',
          revokedBy: person,
        },
      );
      const expired = await seedApiToken(
        database,
        scene.organisationId,
        person,
        {
          expiresAt: at(-DAY),
        },
      );
      // Someone else's, and the owner's own.
      const colleague = await seedApiToken(
        database,
        scene.organisationId,
        scene.tokensId,
      );
      const owners = await seedApiToken(
        database,
        scene.organisationId,
        scene.ownerId,
      );

      const made1 = next();
      const made2 = await link(person, made1);
      const now = next();
      await db().transaction((tx) => useAccessReset(tx, made2.token, now));

      const rows = new Map(
        (await db().select().from(apiToken)).map((row) => [row.id, row]),
      );
      for (const token of [first, second, timed]) {
        expect(rows.get(token.id), token.id).toMatchObject({
          revokedAt: now,
          revokeReason: 'access-reset',
          revokedBy: null,
          version: 2,
        });
      }
      expect(rows.get(revoked.id)).toMatchObject({
        revokeReason: 'manual',
        version: 1,
      });
      expect(rows.get(expired.id)).toMatchObject({
        revokedAt: null,
        version: 1,
      });
      expect(rows.get(colleague.id)).toMatchObject({
        revokedAt: null,
        version: 1,
      });
      expect(rows.get(owners.id)).toMatchObject({
        revokedAt: null,
        version: 1,
      });

      const used = (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.accessResetUsed &&
          event.occurredAt.getTime() === now.getTime(),
      );
      expect(used).toHaveLength(1);
      expect(used[0]!.details).toMatchObject({
        userId: person,
        tokensRevoked: 3,
      });
    });

    it('stops a token that was made through the service, the moment the link is used', async () => {
      // The person needs api:tokens to make one: give the role that does to a member
      // who has nothing else, so the link is allowed (the owner holds everything).
      const person = scene.tokensId;
      const sessionId = await seedSession(database, person);
      const made = await db().transaction((tx) =>
        createApiToken(
          tx,
          { userId: person, sessionId },
          scene.organisationId,
          { name: 'Script', access: 'read' },
          next(),
        ),
      );
      expect(
        await db().transaction((tx) =>
          authenticateApiToken(tx, made.token, next()),
        ),
      ).toMatchObject({ credential: { tokenId: made.apiToken.id } });

      const issued = await link(person, next());
      await db().transaction((tx) => useAccessReset(tx, issued.token, next()));

      const refused = await db().transaction(async (tx) => {
        try {
          return await authenticateApiToken(tx, made.token, next());
        } catch (error) {
          return error;
        }
      });
      expect(refused).toBeInstanceOf(ApiTokenInvalidError);
      expect((refused as ApiTokenInvalidError).reason).toBe('revoked');
    });

    it('counts none when the person has none, and writes the count all the same', async () => {
      const issued = await link(scene.medicalId, next());
      const now = next();
      await db().transaction((tx) => useAccessReset(tx, issued.token, now));
      const used = (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.accessResetUsed &&
          event.occurredAt.getTime() === now.getTime(),
      );
      expect(used[0]!.details).toMatchObject({ tokensRevoked: 0 });
    });

    it('revokes nothing when the link is refused, because the use leaves nothing behind', async () => {
      const person = scene.managerId;
      const token = await seedApiToken(database, scene.organisationId, person);
      const issued = await link(person, next(), 1);
      // After the link has ended, a use is refused and changes nothing.
      const after = new Date(at(0).getTime() + 400 * DAY);
      const refused = await db().transaction(async (tx) => {
        try {
          return await useAccessReset(tx, issued.token, after);
        } catch (error) {
          return error;
        }
      });
      expect(refused).toBeInstanceOf(AccessResetInvalidError);
      expect(
        (await db().select().from(apiToken)).find((row) => row.id === token.id),
      ).toMatchObject({ revokedAt: null, revokeReason: null, version: 1 });
    });
  },
);
