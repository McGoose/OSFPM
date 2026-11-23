import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TokenCredential } from '../access/credential.js';
import { AccessDeniedError } from '../access/access-denied-error.js';
import { seedTokenScene, type TokenScene } from '../auth/test-support.js';
import type { Database } from '../db/client.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { listMembers } from './service.js';

/**
 * The member list through a personal API token: the same list, narrowed (SC-10,
 * decision D-68). A token lists members only in its own organisation, only as a token
 * for the whole organisation, and its owner must hold `members:read`, as for a session.
 */

const T0 = new Date('2026-03-02T09:00:00.000Z');

describe.each(testTargets)(
  'listing members through a token on $name',
  (target) => {
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

    const db = () => database.db;
    const token = (
      overrides: Partial<TokenCredential> = {},
    ): TokenCredential => ({
      kind: 'token',
      tokenId: '0199a3c4-0000-7000-8000-0000000000cc',
      organisationId: scene.organisationId,
      projectId: null,
      access: 'read',
      sensitivePermissions: [],
      ...overrides,
    });
    const list = (userId: string, credential?: TokenCredential) =>
      listMembers(
        db(),
        { userId, ...(credential === undefined ? {} : { credential }) },
        scene.organisationId,
      );

    it('lists the same members to a read token as to its owner’s session', async () => {
      const asSession = await list(scene.ownerId);
      const asToken = await list(scene.ownerId, token({ access: 'read' }));
      expect(asToken).toEqual(asSession);
      expect(asToken.length).toBeGreaterThan(3);
      // A write token lists them too: listing is a read.
      expect(await list(scene.ownerId, token({ access: 'write' }))).toEqual(
        asSession,
      );
    });

    it('refuses a project token, which has no organisation-level access, and a token for another organisation', async () => {
      for (const credential of [
        token({ projectId: scene.projectId }),
        token({ organisationId: scene.otherOrganisationId }),
      ]) {
        const refused = await list(scene.ownerId, credential).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(refused).toBeInstanceOf(AccessDeniedError);
        expect((refused as AccessDeniedError).permission).toBe('members:read');
        expect((refused as AccessDeniedError).scope).toBeUndefined();
      }
    });

    it('refuses a token whose owner does not hold members:read: a token is never more than its owner', async () => {
      await expect(list(scene.tokensId, token())).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      await expect(list(scene.strangerId, token())).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
    });
  },
);
