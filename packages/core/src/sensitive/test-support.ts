import { eq } from 'drizzle-orm';
import type { TokenCredential } from '../access/credential.js';
import {
  API_PERSONAL_TOKENS_SETTING,
  API_SENSITIVE_TOKENS_SETTING,
} from '../access/api-token-switches.js';
import {
  base,
  engagePerson,
  ensurePermissions,
  grantOnOrganisation,
  ORIGIN,
  seedOrganisation,
  seedPerson,
  seedProject,
  seedUser,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  project,
  projectMembership,
  projectMembershipRole,
  role,
  rolePermission,
  settingValue,
  type ProjectMembershipStatus,
} from '../db/schema/index.js';
import { createAccessProfile } from './access-profile.js';
import { VALID_PAYLOADS } from './payload-fixtures.js';
import {
  editPermissionKey,
  readPermissionKey,
  SENSITIVE_PERMISSIONS,
} from './permissions.js';
import type { SensitiveContext } from './service.js';

/**
 * Helpers for the tests of the access needs model (decision D-69). Fixtures insert straight
 * into the tables, as the other tests do (CLAUDE.md, Data rules); the code under test writes
 * through the sensitive service. Only tests import this file. People are invented, from the
 * demo production The Last Withdrawal.
 */

/** The moment every context here says it is: a Sunday in the middle of the shoot. */
export const NOW = new Date('2026-11-15T10:00:00.000Z');

/** A context for `userId`, with a clock that stands at `NOW`, or at `at`. */
export function ctxFor(
  userId: string,
  options: { credential?: TokenCredential; at?: Date } = {},
): SensitiveContext {
  const at = options.at ?? NOW;
  return {
    userId,
    originServer: ORIGIN,
    clock: () => at,
    ...(options.credential === undefined
      ? {}
      : { credential: options.credential }),
  };
}

/** A personal API token's credential, with the sensitive scope given, for an owner in `organisationId`. */
export function tokenFor(
  organisationId: string,
  sensitivePermissions: readonly string[],
  overrides: Partial<TokenCredential> = {},
): TokenCredential {
  return {
    kind: 'token',
    tokenId: '0199a3c4-0000-7000-8000-0000000000aa',
    organisationId,
    projectId: null,
    access: 'read',
    sensitivePermissions,
    ...overrides,
  };
}

/**
 * Turns on the organisation's two switches for personal API tokens, the one for tokens and
 * the one for a sensitive scope, as an administrator would, so a test of a token can pass
 * them. Delete the rows to turn them off again.
 */
export async function turnTokensOn(
  database: Database,
  organisationId: string,
): Promise<void> {
  for (const key of [
    API_PERSONAL_TOKENS_SETTING,
    API_SENSITIVE_TOKENS_SETTING,
  ]) {
    await database.db.insert(settingValue).values({
      ...base(organisationId),
      layer: 'org',
      projectId: null,
      key,
      value: true,
    });
  }
}

/** An organisation role (a template, with no project) holding the permission keys given. Answers its id. */
export async function seedRole(
  database: Database,
  organisationId: string,
  key: string,
  permissionKeys: readonly string[],
  options: { projectId?: string | null } = {},
): Promise<string> {
  const [created] = await database.db
    .insert(role)
    .values({
      ...base(organisationId),
      projectId: options.projectId ?? null,
      key,
      name: key,
    })
    .returning();
  for (const permissionKey of permissionKeys) {
    await database.db.insert(rolePermission).values({
      ...base(organisationId),
      roleId: created!.id,
      permissionKey,
    });
  }
  return created!.id;
}

/** Puts `userId` on `projectId` with the roles given, in a membership that is `active` unless said otherwise. Answers the membership id. */
export async function joinProject(
  database: Database,
  organisationId: string,
  projectId: string,
  userId: string,
  roleIds: readonly string[],
  options: { status?: ProjectMembershipStatus } = {},
): Promise<string> {
  const [membership] = await database.db
    .insert(projectMembership)
    .values({
      ...base(organisationId),
      projectId,
      userId,
      status: options.status ?? 'active',
    })
    .returning();
  for (const roleId of roleIds) {
    await database.db.insert(projectMembershipRole).values({
      ...base(organisationId),
      membershipId: membership!.id,
      roleId,
    });
  }
  return membership!.id;
}

/** Everything the access needs tests stand on: an organisation, two projects, roles, staff and two people. */
export type AccessScene = {
  readonly organisationId: string;
  /** The production of the scene, The Last Withdrawal. */
  readonly projectId: string;
  /** Another project of the organisation. */
  readonly otherProjectId: string;
  readonly roles: {
    /** Reads accessibility and medical data. */
    readonly production: string;
    /** Reads accessibility data. */
    readonly camera: string;
    /** Reads both, and is the role no grant of the scene names. */
    readonly unnamed: string;
    /** Edits and reads both: the staff who record a person's data and choices. */
    readonly coordinator: string;
  };
  readonly users: {
    /** Holds `production` on the project. */
    readonly producer: string;
    /** Holds `camera` on the project. */
    readonly cameraLead: string;
    /** Holds `production` and `camera` on the project. */
    readonly both: string;
    /** Holds `unnamed` on the project: the read permission, and no role a grant names. */
    readonly plainReader: string;
    /** Holds `coordinator` on the project. */
    readonly coordinator: string;
    /** Holds `production` on the other project only. */
    readonly elsewhere: string;
    /** A tier `owner` that holds the sensitive permissions in the organisation, and no project membership. */
    readonly owner: string;
    /** A tier `admin` that holds the sensitive permissions in the organisation, and no project membership. */
    readonly admin: string;
    /** Signed in, a member of nothing. */
    readonly stranger: string;
  };
  readonly people: {
    /** A person with an account, on the project. */
    readonly holder: { readonly userId: string; readonly personId: string };
    /** A person without an account, on the project. */
    readonly crew: { readonly personId: string };
  };
};

/** Every sensitive permission key the scene's roles draw on. */
const SENSITIVE_KEYS = SENSITIVE_PERMISSIONS.map(
  (permission) => permission.key,
);

/**
 * Builds the scene. The permission catalogue gets the sensitive permissions, the roles are
 * organisation templates, and the people are both engaged on `projectId` with status
 * `confirmed`. Direct inserts, as fixtures do.
 */
export async function seedAccessScene(
  database: Database,
): Promise<AccessScene> {
  const organisation = await seedOrganisation(database);
  const { organisationId, projectId } = organisation;
  const otherProjectId = await seedProject(database, organisationId);
  await ensurePermissions(database, SENSITIVE_KEYS);
  await turnTokensOn(database, organisationId);

  const roles = {
    production: await seedRole(database, organisationId, 'production', [
      readPermissionKey('accessibility'),
      readPermissionKey('medical'),
    ]),
    camera: await seedRole(database, organisationId, 'camera', [
      readPermissionKey('accessibility'),
    ]),
    unnamed: await seedRole(database, organisationId, 'unnamed', [
      readPermissionKey('accessibility'),
      readPermissionKey('medical'),
    ]),
    coordinator: await seedRole(database, organisationId, 'coordinator', [
      readPermissionKey('accessibility'),
      readPermissionKey('medical'),
      editPermissionKey('accessibility'),
      editPermissionKey('medical'),
    ]),
  };

  const onProject = async (roleIds: readonly string[], on = projectId) => {
    const userId = await seedUser(database);
    await joinProject(database, organisationId, on, userId, roleIds);
    return userId;
  };
  const owner = await seedUser(database);
  await grantOnOrganisation(
    database,
    organisationId,
    owner,
    'owner',
    SENSITIVE_KEYS,
  );
  const admin = await seedUser(database);
  await grantOnOrganisation(
    database,
    organisationId,
    admin,
    'admin',
    SENSITIVE_KEYS,
  );

  const users = {
    producer: await onProject([roles.production]),
    cameraLead: await onProject([roles.camera]),
    both: await onProject([roles.production, roles.camera]),
    plainReader: await onProject([roles.unnamed]),
    coordinator: await onProject([roles.coordinator]),
    elsewhere: await onProject([roles.production], otherProjectId),
    owner,
    admin,
    stranger: await seedUser(database),
  };

  const holderUser = await seedUser(database);
  const holderPerson = await seedPerson(database, organisationId, {
    userId: holderUser,
    displayName: 'Mira Vukovic',
  });
  await engagePerson(database, organisationId, projectId, holderPerson);
  const crewPerson = await seedPerson(database, organisationId, {
    displayName: 'Tomas Berg',
  });
  await engagePerson(database, organisationId, projectId, crewPerson);

  return {
    organisationId,
    projectId,
    otherProjectId,
    roles,
    users,
    people: {
      holder: { userId: holderUser, personId: holderPerson },
      crew: { personId: crewPerson },
    },
  };
}

/**
 * A person with an account, engaged on the scene's project, who has made an access profile
 * (`payload`, the valid accessibility payload unless given). A fresh one on each call, so a
 * test that changes what a person has shared leaves no one else's state behind.
 */
export async function seedProfileHolder(
  database: Database,
  scene: AccessScene,
  displayName: string,
  payload: Record<string, unknown> = VALID_PAYLOADS.accessibility,
): Promise<{ readonly userId: string; readonly personId: string }> {
  const userId = await seedUser(database);
  const personId = await seedPerson(database, scene.organisationId, {
    userId,
    displayName,
  });
  await engagePerson(database, scene.organisationId, scene.projectId, personId);
  await createAccessProfile(database.db, ctxFor(userId), userId, payload);
  return { userId, personId };
}

/** Sets columns of the project directly, as a test of a wrapped or closed production needs. */
export async function updateProject(
  database: Database,
  projectId: string,
  values: Partial<typeof project.$inferInsert>,
): Promise<void> {
  await database.db
    .update(project)
    .set(values)
    .where(eq(project.id, projectId));
}
