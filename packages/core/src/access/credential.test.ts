import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setApiTokenSwitches } from '../auth/api-tokens.js';
import { seedTokenScene, type TokenScene } from '../auth/test-support.js';
import type { Database } from '../db/client.js';
import { role, rolePermission, settingValue } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  credentialPermits,
  SESSION_CREDENTIAL,
  type TokenCredential,
} from './credential.js';
import { hasOrganisationPermission } from './organisation-permission.js';
import { hasProjectPermission } from './project-permission.js';
import { hasScopedPermission } from './scoped-permission.js';

/**
 * What a personal API token may pass: its owner's access, narrowed (SC-10, decisions
 * D-17 and D-68). A token works only in its own organisation; a project token passes
 * project checks for its project and no check at organisation level; a `read` token
 * never passes a write permission; and a sensitive permission needs the token's
 * explicit sensitive scope, the organisation's sensitive switch on, and the owner to
 * hold the permission at that moment. The checks are given the credential as a last
 * argument; without one they are not narrowed, as for a session.
 */

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
let clock = 0;
const next = () => new Date(T0.getTime() + (clock += 1) * MINUTE);

describe.each(testTargets)(
  'a token’s narrowing of permission checks on $name',
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

    /** A token credential for the scene's organisation, with what a test changes. */
    const token = (
      overrides: Partial<TokenCredential> = {},
    ): TokenCredential => ({
      kind: 'token',
      tokenId: '0199a3c4-0000-7000-8000-0000000000aa',
      organisationId: scene.organisationId,
      projectId: null,
      access: 'write',
      sensitivePermissions: [],
      ...overrides,
    });
    const switches = (personalTokens: boolean, sensitive: boolean) =>
      db().transaction((tx) =>
        setApiTokenSwitches(
          tx,
          { userId: scene.ownerId },
          scene.organisationId,
          { personalTokens, sensitive },
          next(),
        ),
      );
    const inOrganisation = (
      userId: string,
      key: string,
      credential?: TokenCredential,
      organisationId = scene.organisationId,
    ) =>
      hasOrganisationPermission(db(), userId, organisationId, key, credential);
    const onProject = (
      userId: string,
      projectId: string,
      key: string,
      credential?: TokenCredential,
    ) => hasProjectPermission(db(), userId, projectId, key, credential);

    afterEach(async () => {
      await db().delete(settingValue);
    });

    describe('without a token, or with a session', () => {
      it('is not narrowed: the owner passes what the owner holds', async () => {
        expect(await inOrganisation(scene.ownerId, 'members:invite')).toBe(
          true,
        );
        expect(
          await inOrganisation(
            scene.ownerId,
            'members:invite',
            SESSION_CREDENTIAL as never,
          ),
        ).toBe(true);
        expect(
          await onProject(
            scene.ownerId,
            scene.projectId,
            'accounts:edit',
            SESSION_CREDENTIAL as never,
          ),
        ).toBe(true);
        // And is refused what the owner does not hold, as before.
        expect(await inOrganisation(scene.plainId, 'members:invite')).toBe(
          false,
        );
        expect(
          await credentialPermits(
            db(),
            undefined,
            { organisationId: scene.organisationId, projectId: null },
            'members:invite',
          ),
        ).toBe(true);
        expect(
          await credentialPermits(
            db(),
            SESSION_CREDENTIAL,
            { organisationId: scene.organisationId, projectId: null },
            'sensitive:read:medical',
          ),
        ).toBe(true);
      });
    });

    describe('the organisation', () => {
      it('is the only one a token works in', async () => {
        expect(
          await inOrganisation(scene.ownerId, 'members:read', token()),
        ).toBe(true);
        // The owner holds the permission here, and the token is for the other organisation.
        expect(
          await inOrganisation(
            scene.ownerId,
            'members:read',
            token({ organisationId: scene.otherOrganisationId }),
          ),
        ).toBe(false);
        // Asked about the other organisation, the base check is false too, so ask the
        // narrowing alone: the token is for one, the scope is another.
        expect(
          await credentialPermits(
            db(),
            token(),
            { organisationId: scene.otherOrganisationId, projectId: null },
            'members:read',
          ),
        ).toBe(false);
        // A project of another organisation is not the token's, whoever asks.
        expect(
          await onProject(
            scene.ownerId,
            scene.foreignProjectId,
            'accounts:read',
            token(),
          ),
        ).toBe(false);
      });
    });

    describe('the project', () => {
      it('is the only one a project token works on, and it passes no check at organisation level', async () => {
        const onFirst = token({ projectId: scene.projectId });
        expect(
          await onProject(
            scene.ownerId,
            scene.projectId,
            'accounts:read',
            onFirst,
          ),
        ).toBe(true);
        expect(
          await onProject(
            scene.ownerId,
            scene.otherProjectId,
            'accounts:read',
            onFirst,
          ),
        ).toBe(false);
        // The owner holds the permission in the organisation; the token is for a project.
        expect(await inOrganisation(scene.ownerId, 'members:read')).toBe(true);
        expect(
          await inOrganisation(scene.ownerId, 'members:read', onFirst),
        ).toBe(false);
        // And the same through the check that takes either scope.
        expect(
          await hasScopedPermission(
            db(),
            scene.ownerId,
            { organisationId: scene.organisationId, projectId: null },
            'members:read',
            onFirst,
          ),
        ).toBe(false);
        expect(
          await hasScopedPermission(
            db(),
            scene.ownerId,
            {
              organisationId: scene.organisationId,
              projectId: scene.projectId,
            },
            'accounts:read',
            onFirst,
          ),
        ).toBe(true);
      });

      it('lets a token of the whole organisation pass a project check, and an organisation check', async () => {
        const whole = token();
        expect(
          await onProject(
            scene.ownerId,
            scene.projectId,
            'accounts:read',
            whole,
          ),
        ).toBe(true);
        expect(
          await onProject(
            scene.ownerId,
            scene.otherProjectId,
            'accounts:read',
            whole,
          ),
        ).toBe(true);
        expect(await inOrganisation(scene.ownerId, 'members:read', whole)).toBe(
          true,
        );
      });
    });

    describe('read and write', () => {
      it('refuses a read token every permission classed write, though the owner holds it, and lets it pass the read ones', async () => {
        const reader = token({ access: 'read' });
        for (const key of [
          'members:invite',
          'members:reset-access',
          'accounts:edit',
          'contracts:edit',
          'legal-hold:manage',
          // Mixed, so classed write: a read token cannot hold it.
          'contracts:read-value',
        ]) {
          expect(await inOrganisation(scene.ownerId, key), key).toBe(true);
          expect(await inOrganisation(scene.ownerId, key, reader), key).toBe(
            false,
          );
        }
        for (const key of ['members:read', 'accounts:read', 'contracts:read']) {
          expect(await inOrganisation(scene.ownerId, key, reader), key).toBe(
            true,
          );
        }
        // On a project too.
        expect(
          await onProject(
            scene.ownerId,
            scene.projectId,
            'accounts:edit',
            token({ access: 'read' }),
          ),
        ).toBe(false);
        expect(
          await onProject(
            scene.ownerId,
            scene.projectId,
            'accounts:read',
            token({ access: 'read' }),
          ),
        ).toBe(true);
      });

      it('lets a write token pass both', async () => {
        const writer = token({ access: 'write' });
        expect(
          await inOrganisation(scene.ownerId, 'members:invite', writer),
        ).toBe(true);
        expect(
          await inOrganisation(scene.ownerId, 'members:read', writer),
        ).toBe(true);
      });

      it('never gives a token more than its owner holds', async () => {
        // The token is write and for the organisation; the member holds neither.
        expect(
          await inOrganisation(scene.plainId, 'members:invite', token()),
        ).toBe(false);
        expect(
          await onProject(
            scene.plainId,
            scene.projectId,
            'accounts:edit',
            token(),
          ),
        ).toBe(false);
        // A permission nobody has classed is write: a read token never holds it.
        expect(
          await credentialPermits(
            db(),
            token({ access: 'read' }),
            { organisationId: scene.organisationId, projectId: null },
            'budget:read',
          ),
        ).toBe(false);
      });
    });

    describe('a sensitive permission', () => {
      const KEY = 'sensitive:read:medical';
      const OTHER = 'sensitive:read:dietary';

      it('is refused to a token without the scope, on every sensitive permission, even when the owner holds it', async () => {
        await switches(true, true);
        expect(await inOrganisation(scene.ownerId, KEY)).toBe(true);
        const bare = token({ access: 'write' });
        for (const key of [
          KEY,
          OTHER,
          'sensitive:edit:medical',
          'costs:read',
          'contracts:read-value',
        ]) {
          expect(await inOrganisation(scene.ownerId, key), key).toBe(true);
          expect(await inOrganisation(scene.ownerId, key, bare), key).toBe(
            false,
          );
        }
        // On a project, where the member holds it through a project role.
        expect(await onProject(scene.medicalId, scene.projectId, KEY)).toBe(
          true,
        );
        expect(
          await onProject(scene.medicalId, scene.projectId, KEY, token()),
        ).toBe(false);
      });

      it('is passed with the scope, the switch on and the owner holding it, and only for the keys listed', async () => {
        await switches(true, true);
        const scoped = token({ sensitivePermissions: [KEY] });
        expect(await inOrganisation(scene.ownerId, KEY, scoped)).toBe(true);
        // The owner holds this one too, and it is not in the scope.
        expect(await inOrganisation(scene.ownerId, OTHER, scoped)).toBe(false);
        expect(
          await inOrganisation(scene.ownerId, 'sensitive:edit:medical', scoped),
        ).toBe(false);
        // A project token with the scope, on its project, for a member who holds it there.
        const onProjectScoped = token({
          projectId: scene.projectId,
          sensitivePermissions: [KEY],
        });
        expect(
          await onProject(
            scene.medicalId,
            scene.projectId,
            KEY,
            onProjectScoped,
          ),
        ).toBe(true);
        expect(
          await onProject(
            scene.medicalId,
            scene.otherProjectId,
            KEY,
            onProjectScoped,
          ),
        ).toBe(false);
      });

      it('is refused again once the sensitive switch goes off, though the credential still lists it', async () => {
        await switches(true, true);
        const scoped = token({ sensitivePermissions: [KEY] });
        expect(await inOrganisation(scene.ownerId, KEY, scoped)).toBe(true);
        await switches(true, false);
        expect(await inOrganisation(scene.ownerId, KEY, scoped)).toBe(false);
        // The ordinary permissions are untouched by that switch.
        expect(
          await inOrganisation(scene.ownerId, 'members:read', scoped),
        ).toBe(true);
        await switches(false, false);
        expect(await inOrganisation(scene.ownerId, KEY, scoped)).toBe(false);
      });

      it('is refused again once the owner loses the permission, which is the owner’s access at that moment', async () => {
        await switches(true, true);
        const scoped = token({ sensitivePermissions: [KEY] });
        expect(await inOrganisation(scene.medicalId, KEY, scoped)).toBe(true);
        // The role the member holds loses the permission (a fixture edits the grant).
        const [medicalRole] = await db()
          .select()
          .from(role)
          .where(
            and(
              eq(role.organisationId, scene.organisationId),
              eq(role.key, 'medical'),
            ),
          );
        await db()
          .update(rolePermission)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(rolePermission.roleId, medicalRole!.id),
              eq(rolePermission.permissionKey, KEY),
            ),
          );
        try {
          expect(await inOrganisation(scene.medicalId, KEY)).toBe(false);
          expect(await inOrganisation(scene.medicalId, KEY, scoped)).toBe(
            false,
          );
        } finally {
          await db()
            .update(rolePermission)
            .set({ deletedAt: null })
            .where(
              and(
                eq(rolePermission.roleId, medicalRole!.id),
                eq(rolePermission.permissionKey, KEY),
              ),
            );
        }
        expect(await inOrganisation(scene.medicalId, KEY, scoped)).toBe(true);
      });

      it('treats a key the catalogue does not know as sensitive, so an unknown key fails closed', async () => {
        await switches(true, true);
        // A write token, so only the sensitivity of the key can refuse it: nothing in
        // the catalogue says it is ordinary, so it needs the scope, which it has not.
        expect(
          await credentialPermits(
            db(),
            token({ access: 'write' }),
            { organisationId: scene.organisationId, projectId: null },
            'no-such:permission',
          ),
        ).toBe(false);
        expect(
          await credentialPermits(
            db(),
            token({ access: 'write' }),
            { organisationId: scene.organisationId, projectId: null },
            'members:read',
          ),
        ).toBe(true);
      });
    });
  },
);
