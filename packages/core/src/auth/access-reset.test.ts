import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessDeniedError } from '../access/access-denied-error.js';
import { hasOrganisationPermission } from '../access/organisation-permission.js';
import { PERMISSION_LISTS } from '../access/permission-lists.js';
import { ORIGIN, seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  accessReset,
  auditEvent,
  changeEvent,
  orgMembership,
  user,
  type OrgMembershipStatus,
  type OrgRole,
} from '../db/schema/index.js';
import { RecordNotFoundError } from '../db/write.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  MEMBER_PERMISSIONS,
  MEMBERS_RESET_ACCESS_PERMISSION,
} from '../members/permissions.js';
import { cleanupAccessResets } from './access-reset-cleanup.js';
import {
  AccessResetInvalidError,
  CannotResetSelfError,
  OwnerResetNeedsOwnerError,
  ResetExceedsOwnAccessError,
  UserInOtherOrganisationsError,
  UserNotActiveError,
} from './access-reset-errors.js';
import {
  ACCESS_RESET_LIFETIME,
  createAccessReset,
  inspectAccessReset,
  revokeAccessReset,
  type CreateAccessResetInput,
} from './access-reset.js';
import { AUTH_AUDIT } from './shared.js';
import {
  DEMO_ADMIN_EMAIL,
  everyRowAsText,
  markUserDeleted,
  seedMembership,
  seedOrganisationRole,
  seedResetScene,
  setUserStatus,
  type ResetScene,
} from './test-support.js';
import { hashToken } from './tokens.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(T0.getTime() + ms);

describe.each(testTargets)('admin reset links on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scene: ResetScene;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    scene = await seedResetScene(database, T0);
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;
  /** Every token a link made, for the checks that none of them is kept anywhere. */
  const tokens: string[] = [];

  /** A member of the organisation, active, with a tier and roles of their own. */
  const makeTarget = async (
    options: {
      tier?: OrgRole;
      roleIds?: readonly string[];
      membershipStatus?: OrgMembershipStatus;
    } = {},
  ) => {
    const userId = await seedUser(database);
    await seedMembership(
      database,
      scene.organisationId,
      userId,
      options.tier ?? 'member',
      options.roleIds ?? [scene.roles.crew],
      options.membershipStatus === undefined
        ? {}
        : { status: options.membershipStatus },
    );
    return userId;
  };

  /** Makes a link as `actorId` for `targetId`, at a time of its own so the order is clear. */
  let clock = 10;
  const link = async (
    actorId: string,
    targetId: string,
    input: CreateAccessResetInput = {},
    when: Date = at((clock += 1) * MINUTE),
  ) => {
    const made = await createAccessReset(
      db(),
      { userId: actorId },
      scene.organisationId,
      targetId,
      input,
      when,
    );
    tokens.push(made.token);
    return made;
  };

  const audits = async (category: string) =>
    (await db().select().from(auditEvent)).filter(
      (event) => event.category === category,
    );
  const row = async (id: string) =>
    (await db().select().from(accessReset).where(eq(accessReset.id, id)))[0]!;
  const rowsOfUser = async (userId: string) =>
    (await db().select().from(accessReset)).filter(
      (found) => found.userId === userId,
    );
  const liveRowsOfUser = async (userId: string) =>
    (await rowsOfUser(userId)).filter(
      (found) => found.usedAt === null && found.revokedAt === null,
    );
  const totals = async () => ({
    links: (await db().select().from(accessReset)).length,
    events: (await db().select().from(auditEvent)).length,
  });

  /** The rejection of a promise, or a failure if it resolved. */
  const rejection = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error('Expected the call to be refused, but it succeeded');
  };

  describe('the permission', () => {
    it('is an ordinary organisation-level permission of the members module, in the registry the server syncs at start-up', () => {
      const entry = MEMBER_PERMISSIONS.find(
        (found) => found.key === MEMBERS_RESET_ACCESS_PERMISSION,
      );
      expect(entry).toMatchObject({
        key: 'members:reset-access',
        module: 'members',
        grantsSensitive: false,
      });
      expect(entry!.description.length).toBeGreaterThan(0);
      expect(PERMISSION_LISTS.flat().map((entry) => entry.key)).toContain(
        'members:reset-access',
      );
    });

    it('is held by the owner of the organisation through the Administrator role, and by no one who was given nothing', async () => {
      for (const [userId, expected] of [
        [scene.ownerId, true],
        [scene.adminId, true],
        [scene.resetterId, true],
        [scene.plainId, false],
        [scene.strangerId, false],
      ] as const) {
        expect(
          await hasOrganisationPermission(
            db(),
            userId,
            scene.organisationId,
            MEMBERS_RESET_ACCESS_PERMISSION,
          ),
          userId,
        ).toBe(expected);
      }
    });
  });

  describe('createAccessReset', () => {
    it('makes a link for a member and returns it with its token: 43 base64url characters, shown once', async () => {
      const person = await makeTarget();
      const made = await link(scene.ownerId, person);
      expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(made.reset).toMatchObject({
        organisationId: scene.organisationId,
        userId: person,
        removePasskeys: false,
        createdBy: scene.ownerId,
      });
      expect(
        made.reset.expiresAt.getTime() - made.reset.createdAt.getTime(),
      ).toBe(ACCESS_RESET_LIFETIME.defaultHours * HOUR);
      expect(ACCESS_RESET_LIFETIME.defaultHours).toBe(24);
      // The view has no hash and no token.
      expect(Object.keys(made.reset).sort()).toEqual(
        [
          'createdAt',
          'createdBy',
          'expiresAt',
          'id',
          'organisationId',
          'removePasskeys',
          'userId',
        ].sort(),
      );
    });

    it('stores only the hash of the token, in no table and no event as the token', async () => {
      const person = await makeTarget();
      const made = await link(scene.ownerId, person);
      expect((await row(made.reset.id)).tokenHash).toBe(hashToken(made.token));
      expect(await everyRowAsText(database)).not.toContain(made.token);
      expect(
        JSON.stringify(await db().select().from(auditEvent)),
      ).not.toContain(made.token);
      expect(
        JSON.stringify(await db().select().from(changeEvent)),
      ).not.toContain(made.token);
    });

    it('lasts the hours asked for, from 1 to 72, and refuses any other number', async () => {
      const person = await makeTarget();
      for (const hours of [1, 72]) {
        const made = await link(scene.ownerId, person, {
          expiresInHours: hours,
        });
        expect(
          made.reset.expiresAt.getTime() - made.reset.createdAt.getTime(),
        ).toBe(hours * HOUR);
      }
      for (const hours of [0, 73, -1, 1.5, Number.NaN, 1000, '24' as never]) {
        await expect(
          link(scene.ownerId, person, { expiresInHours: hours }),
          String(hours),
        ).rejects.toMatchObject({
          name: 'AuthInputError',
          field: 'expiresInHours',
        });
      }
    });

    it('says whether using the link also removes the passkeys, and refuses a value that is not true or false', async () => {
      const person = await makeTarget();
      const kept = await link(scene.ownerId, person, { removePasskeys: false });
      expect((await row(kept.reset.id)).removePasskeys).toBe(false);
      const removed = await link(scene.ownerId, person, {
        removePasskeys: true,
      });
      expect(removed.reset.removePasskeys).toBe(true);
      expect((await row(removed.reset.id)).removePasskeys).toBe(true);
      for (const value of ['yes', 1, null, {}]) {
        await expect(
          link(scene.ownerId, person, { removePasskeys: value as never }),
          JSON.stringify(value),
        ).rejects.toMatchObject({
          name: 'AuthInputError',
          field: 'removePasskeys',
        });
      }
    });

    describe('rule 1: the creator holds members:reset-access in this organisation', () => {
      it('refuses a member without it, a stranger, a person with no membership, an organisation that does not exist, a person who is not a member here and an id that is nobody, with one answer', async () => {
        const person = await makeTarget();
        const nobody = await seedUser(database);
        const before = await totals();
        const refusals = [
          await rejection(link(scene.plainId, person)),
          await rejection(link(scene.strangerId, person)),
          await rejection(link(nobody, person)),
          await rejection(
            createAccessReset(
              db(),
              { userId: scene.ownerId },
              newId(),
              person,
              {},
              at(5 * MINUTE),
            ),
          ),
          // The creator may reset, but the person is in another organisation only.
          await rejection(link(scene.ownerId, scene.strangerId)),
          // ... or does not exist, or is not an id.
          await rejection(link(scene.ownerId, newId())),
          await rejection(link(scene.ownerId, 'not-an-id')),
        ];
        for (const refusal of refusals) {
          expect(refusal).toBeInstanceOf(AccessDeniedError);
          expect(refusal).toMatchObject({
            permission: 'members:reset-access',
            scope: undefined,
          });
        }
        // One message for all, so the answer never says which it was.
        expect(
          new Set(refusals.map((refusal) => (refusal as Error).message)),
        ).toHaveProperty('size', 1);
        // Nothing was written, not even an event: a denial here is not audited.
        expect(await totals()).toEqual(before);
      });

      it('does not count a grant limited to a department, or a creator whose account is disabled', async () => {
        const person = await makeTarget();
        const limited = await seedUser(database);
        await seedMembership(
          database,
          scene.organisationId,
          limited,
          'member',
          [
            await seedOrganisationRole(
              database,
              scene.organisationId,
              'resetter-camera',
              [['members:reset-access', 'own-scope', scene.departmentId]],
            ),
          ],
        );
        await expect(link(limited, person)).rejects.toBeInstanceOf(
          AccessDeniedError,
        );
        // A creator who holds the permission, for a person who holds nothing, so
        // that only the state of the creator's account decides.
        const holdsNothing = await makeTarget({ roleIds: [] });
        const gone = await seedUser(database);
        await seedMembership(database, scene.organisationId, gone, 'member', [
          scene.roles.resetter,
        ]);
        await link(gone, holdsNothing);
        await setUserStatus(database, gone, 'disabled');
        await expect(link(gone, holdsNothing)).rejects.toBeInstanceOf(
          AccessDeniedError,
        );
      });

      it('lets a member who holds only the permission make a link for someone who holds nothing it does not', async () => {
        const nothing = await makeTarget({ roleIds: [] });
        const made = await link(scene.resetterId, nothing);
        expect(made.reset.createdBy).toBe(scene.resetterId);
      });
    });

    describe('rule 2: not yourself', () => {
      it('refuses the creator as the person, with cannot-reset-self, whatever they hold', async () => {
        for (const actor of [scene.ownerId, scene.adminId, scene.resetterId]) {
          await expect(link(actor, actor), actor).rejects.toBeInstanceOf(
            CannotResetSelfError,
          );
        }
        // The error carries nothing about the person.
        const error = (await rejection(
          link(scene.ownerId, scene.ownerId),
        )) as Error;
        expect(error.message).not.toContain(scene.ownerId);
      });
    });

    describe('rule 3: every membership the person has is in this organisation', () => {
      it('refuses a person who also belongs to another organisation, whatever the status of that membership, with user-in-other-organisations', async () => {
        const cases: {
          name: string;
          status: OrgMembershipStatus;
          deleted: boolean;
        }[] = [
          { name: 'active', status: 'active', deleted: false },
          { name: 'invited', status: 'invited', deleted: false },
          { name: 'removed', status: 'removed', deleted: false },
          { name: 'deleted row', status: 'active', deleted: true },
        ];
        for (const { name, status, deleted } of cases) {
          const person = await makeTarget();
          await seedMembership(
            database,
            scene.otherOrganisationId,
            person,
            'member',
            [],
            { status, deleted },
          );
          await expect(
            link(scene.ownerId, person),
            name,
          ).rejects.toBeInstanceOf(UserInOtherOrganisationsError);
          expect(await rowsOfUser(person), name).toEqual([]);
        }
      });

      it('refuses only the person who belongs elsewhere: another member of this organisation is not affected', async () => {
        const elsewhere = await makeTarget();
        await seedMembership(
          database,
          scene.otherOrganisationId,
          elsewhere,
          'member',
          [],
        );
        await expect(link(scene.ownerId, elsewhere)).rejects.toBeInstanceOf(
          UserInOtherOrganisationsError,
        );
        const made = await link(scene.ownerId, await makeTarget());
        expect(made.reset.organisationId).toBe(scene.organisationId);
      });
    });

    describe('rule 4: an owner can only be reset by an owner', () => {
      it('refuses an administrator who holds every permission, with owner-reset-needs-owner, and lets an owner make the link', async () => {
        const secondOwner = await makeTarget({
          tier: 'owner',
          roleIds: [scene.roles.administrator],
        });
        await expect(link(scene.adminId, secondOwner)).rejects.toBeInstanceOf(
          OwnerResetNeedsOwnerError,
        );
        expect(await rowsOfUser(secondOwner)).toEqual([]);
        const made = await link(scene.ownerId, secondOwner);
        expect(made.reset.userId).toBe(secondOwner);
      });
    });

    describe('rule 5: nothing the creator does not hold', () => {
      it('refuses a person who holds permissions the creator lacks, listing their keys sorted, with reset-exceeds-own-access', async () => {
        const editor = await makeTarget({ roleIds: [scene.roles.editor] });
        const error = await rejection(link(scene.resetterId, editor));
        expect(error).toBeInstanceOf(ResetExceedsOwnAccessError);
        expect((error as ResetExceedsOwnAccessError).permissions).toEqual([
          'accounts:edit',
          'accounts:read',
        ]);
        // The message carries no key.
        expect((error as Error).message).not.toContain('accounts');
        expect(await rowsOfUser(editor)).toEqual([]);
      });

      it('gives a tier no exception: an owner who holds only members:reset-access is refused a member who holds more', async () => {
        const thinOwner = await makeTarget({
          tier: 'owner',
          roleIds: [scene.roles.resetter],
        });
        const reader = await makeTarget({ roleIds: [scene.roles.crew] });
        await expect(link(thinOwner, reader)).rejects.toMatchObject({
          name: 'ResetExceedsOwnAccessError',
          permissions: ['accounts:read'],
        });
      });

      it('compares reach: a grant for every project needs the same, and a wider creator may reset a narrower person', async () => {
        const narrowCreator = await seedUser(database);
        await seedMembership(
          database,
          scene.organisationId,
          narrowCreator,
          'member',
          [scene.roles.resetter, scene.roles.crew],
        );
        const wideCreator = await seedUser(database);
        await seedMembership(
          database,
          scene.organisationId,
          wideCreator,
          'member',
          [scene.roles.resetter, scene.roles.wide],
        );
        const narrowPerson = await makeTarget({ roleIds: [scene.roles.crew] });
        const widePerson = await makeTarget({ roleIds: [scene.roles.wide] });

        // Own-scope against all-projects: refused, and the key is named.
        await expect(link(narrowCreator, widePerson)).rejects.toMatchObject({
          name: 'ResetExceedsOwnAccessError',
          permissions: ['accounts:read'],
        });
        // The same reach, and a wider one against a narrower one: allowed.
        await link(narrowCreator, narrowPerson);
        await link(wideCreator, widePerson);
        await link(wideCreator, narrowPerson);
      });

      it('counts a grant limited to a department as held: the creator must hold the permission, at any reach', async () => {
        const departmentRole = await seedOrganisationRole(
          database,
          scene.organisationId,
          'crew-camera',
          [['accounts:read', 'own-scope', scene.departmentId]],
        );
        const person = await makeTarget({ roleIds: [departmentRole] });
        await expect(link(scene.resetterId, person)).rejects.toMatchObject({
          name: 'ResetExceedsOwnAccessError',
          permissions: ['accounts:read'],
        });
        const reader = await seedUser(database);
        await seedMembership(database, scene.organisationId, reader, 'member', [
          scene.roles.resetter,
          scene.roles.crew,
        ]);
        await link(reader, person);
      });

      it('lets an administrator who holds every permission reset another administrator', async () => {
        const second = await makeTarget({
          tier: 'admin',
          roleIds: [scene.roles.administrator],
        });
        await link(scene.adminId, second);
      });
    });

    describe('rule 6: the person’s account is active', () => {
      it('refuses a disabled, an invited and a deleted account, with user-not-active', async () => {
        for (const status of ['disabled', 'invited'] as const) {
          const person = await makeTarget();
          await setUserStatus(database, person, status);
          await expect(
            link(scene.ownerId, person),
            status,
          ).rejects.toBeInstanceOf(UserNotActiveError);
        }
        const deleted = await makeTarget();
        await markUserDeleted(database, deleted, at(HOUR));
        await expect(link(scene.ownerId, deleted)).rejects.toBeInstanceOf(
          UserNotActiveError,
        );
      });
    });

    it('checks the rules in their order: the first that fails is the answer', async () => {
      // In another organisation too, and disabled: rule 3 comes before rule 6.
      const person = await makeTarget({ roleIds: [scene.roles.editor] });
      await seedMembership(
        database,
        scene.otherOrganisationId,
        person,
        'member',
        [],
      );
      await setUserStatus(database, person, 'disabled');
      await expect(link(scene.resetterId, person)).rejects.toBeInstanceOf(
        UserInOtherOrganisationsError,
      );
      // A creator without the permission is refused first, whatever else is
      // wrong with the person.
      await expect(link(scene.plainId, person)).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
    });

    describe('one live link for a person', () => {
      it('revokes the earlier live link when a new one is made, audited as revoked with the reason superseded', async () => {
        const person = await makeTarget();
        const first = await link(scene.ownerId, person);
        const before = (await audits(AUTH_AUDIT.accessResetRevoked)).length;
        const second = await link(scene.adminId, person);
        const earlier = await row(first.reset.id);
        expect(earlier.revokedAt).toEqual(second.reset.createdAt);
        expect(earlier.revokedBy).toBe(scene.adminId);
        expect(earlier.usedAt).toBeNull();
        expect(await liveRowsOfUser(person)).toHaveLength(1);
        expect((await liveRowsOfUser(person))[0]!.id).toBe(second.reset.id);
        // The old token stops working, and the new one works.
        await expect(
          inspectAccessReset(db(), first.token, second.reset.createdAt),
        ).rejects.toBeInstanceOf(AccessResetInvalidError);
        await expect(
          inspectAccessReset(db(), second.token, second.reset.createdAt),
        ).resolves.toEqual({ expiresAt: second.reset.expiresAt });
        const revoked = (await audits(AUTH_AUDIT.accessResetRevoked)).slice(
          before,
        );
        expect(revoked).toHaveLength(1);
        expect(revoked[0]).toMatchObject({
          action: 'revoke',
          actorType: 'user',
          actorId: scene.adminId,
          targetType: 'access_reset',
          targetId: first.reset.id,
          organisationId: scene.organisationId,
          details: { userId: person, reason: 'superseded' },
        });
      });

      it('leaves other people’s links, used links, revoked links and expired links as they are', async () => {
        const person = await makeTarget();
        const bystander = await makeTarget();
        const theirs = await link(scene.ownerId, bystander);
        const old = await link(scene.ownerId, person, { expiresInHours: 1 });
        // A used link and a revoked link of the person, made directly.
        const [used] = await db()
          .insert(accessReset)
          .values({
            originServer: ORIGIN,
            organisationId: scene.organisationId,
            userId: person,
            tokenHash: `used-${newId()}`,
            createdAt: at(HOUR),
            createdBy: scene.ownerId,
            expiresAt: at(30 * HOUR),
            usedAt: at(2 * HOUR),
          })
          .returning();
        const [gone] = await db()
          .insert(accessReset)
          .values({
            originServer: ORIGIN,
            organisationId: scene.organisationId,
            userId: person,
            tokenHash: `revoked-${newId()}`,
            createdAt: at(HOUR),
            createdBy: scene.ownerId,
            expiresAt: at(30 * HOUR),
            revokedAt: at(2 * HOUR),
            revokedBy: scene.ownerId,
          })
          .returning();
        // The first link has expired by the time the new one is made.
        const later = at(10 * HOUR);
        const events = (await audits(AUTH_AUDIT.accessResetRevoked)).length;
        const fresh = await link(scene.adminId, person, {}, later);
        expect((await row(theirs.reset.id)).revokedAt).toBeNull();
        expect((await row(used!.id)).usedAt).not.toBeNull();
        expect((await row(used!.id)).revokedAt).toBeNull();
        expect((await row(gone!.id)).revokedBy).toBe(scene.ownerId);
        // The expired link is not live, so it is not revoked (and not "superseded").
        expect((await row(old.reset.id)).revokedAt).toBeNull();
        expect(
          (await liveRowsOfUser(person)).map((found) => found.id),
        ).toContain(fresh.reset.id);
        expect((await audits(AUTH_AUDIT.accessResetRevoked)).length).toBe(
          events,
        );
      });
    });

    it('audits the link as made, by the creator, for the person, with its expiry and passkey flag, and with no token, hash or address', async () => {
      const person = await makeTarget();
      const before = (await audits(AUTH_AUDIT.accessResetCreated)).length;
      const made = await link(scene.adminId, person, {
        expiresInHours: 5,
        removePasskeys: true,
      });
      const [event] = (await audits(AUTH_AUDIT.accessResetCreated)).slice(
        before,
      );
      expect(event).toMatchObject({
        action: 'create',
        actorType: 'user',
        actorId: scene.adminId,
        targetType: 'access_reset',
        targetId: made.reset.id,
        organisationId: scene.organisationId,
        details: {
          userId: person,
          expiresAt: made.reset.expiresAt.toISOString(),
          removePasskeys: true,
        },
      });
      expect((await audits(AUTH_AUDIT.accessResetCreated)).length).toBe(
        before + 1,
      );
      const text = JSON.stringify(event);
      expect(text).not.toContain(made.token);
      expect(text).not.toContain(hashToken(made.token));
      expect(text).not.toContain('@');
    });

    it('writes nothing for a refused link: no row, no event, no revocation of the link it would have replaced', async () => {
      const person = await makeTarget();
      const live = await link(scene.ownerId, person);
      const before = await totals();
      // Refused by rule 6 once the person is disabled.
      await setUserStatus(database, person, 'disabled');
      await expect(link(scene.adminId, person)).rejects.toBeInstanceOf(
        UserNotActiveError,
      );
      expect(await totals()).toEqual(before);
      expect((await row(live.reset.id)).revokedAt).toBeNull();
    });
  });

  describe('revokeAccessReset', () => {
    it('revokes the live link of a person, audited as revoked with the reason manual, and the link stops working', async () => {
      const person = await makeTarget();
      const made = await link(scene.ownerId, person);
      const before = (await audits(AUTH_AUDIT.accessResetRevoked)).length;
      const now = at(500 * MINUTE);
      await revokeAccessReset(
        db(),
        { userId: scene.adminId },
        scene.organisationId,
        person,
        now,
      );
      const revoked = await row(made.reset.id);
      expect(revoked.revokedAt).toEqual(now);
      expect(revoked.revokedBy).toBe(scene.adminId);
      expect(revoked.usedAt).toBeNull();
      await expect(
        inspectAccessReset(db(), made.token, now),
      ).rejects.toBeInstanceOf(AccessResetInvalidError);
      const [event] = (await audits(AUTH_AUDIT.accessResetRevoked)).slice(
        before,
      );
      expect(event).toMatchObject({
        action: 'revoke',
        actorType: 'user',
        actorId: scene.adminId,
        targetType: 'access_reset',
        targetId: made.reset.id,
        organisationId: scene.organisationId,
        details: { userId: person, reason: 'manual' },
      });
    });

    it('is a not-found when the person has no live link: none made, one already revoked, one used, one that expired, or someone who is not a member', async () => {
      const revoke = (userId: string, when: Date) =>
        revokeAccessReset(
          db(),
          { userId: scene.ownerId },
          scene.organisationId,
          userId,
          when,
        );
      const none = await makeTarget();
      await expect(revoke(none, at(600 * MINUTE))).rejects.toBeInstanceOf(
        RecordNotFoundError,
      );
      const again = await makeTarget();
      await link(scene.ownerId, again);
      await revoke(again, at(601 * MINUTE));
      await expect(revoke(again, at(602 * MINUTE))).rejects.toBeInstanceOf(
        RecordNotFoundError,
      );
      const spent = await makeTarget();
      const used = await link(scene.ownerId, spent);
      await db()
        .update(accessReset)
        .set({ usedAt: at(603 * MINUTE) })
        .where(eq(accessReset.id, used.reset.id));
      await expect(revoke(spent, at(604 * MINUTE))).rejects.toBeInstanceOf(
        RecordNotFoundError,
      );
      const stale = await makeTarget();
      const short = await link(scene.ownerId, stale, { expiresInHours: 1 });
      await expect(revoke(stale, short.reset.expiresAt)).rejects.toBeInstanceOf(
        RecordNotFoundError,
      );
      await expect(
        revoke(scene.strangerId, at(605 * MINUTE)),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
      await expect(revoke(newId(), at(606 * MINUTE))).rejects.toBeInstanceOf(
        RecordNotFoundError,
      );
      await expect(
        revoke('not-an-id', at(607 * MINUTE)),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
    });

    it('needs members:reset-access, and answers a stranger as it answers a member without it', async () => {
      const person = await makeTarget();
      const made = await link(scene.ownerId, person);
      const before = await totals();
      const nobody = await seedUser(database);
      for (const userId of [scene.plainId, scene.strangerId, nobody]) {
        await expect(
          revokeAccessReset(
            db(),
            { userId },
            scene.organisationId,
            person,
            at(700 * MINUTE),
          ),
        ).rejects.toMatchObject({
          name: 'AccessDeniedError',
          permission: 'members:reset-access',
          scope: undefined,
        });
      }
      expect(await totals()).toEqual(before);
      expect((await row(made.reset.id)).revokedAt).toBeNull();
    });

    it('revokes only the link of that person', async () => {
      const first = await makeTarget();
      const second = await makeTarget();
      const one = await link(scene.ownerId, first);
      const two = await link(scene.ownerId, second);
      await revokeAccessReset(
        db(),
        { userId: scene.ownerId },
        scene.organisationId,
        first,
        at(800 * MINUTE),
      );
      expect((await row(one.reset.id)).revokedAt).not.toBeNull();
      expect((await row(two.reset.id)).revokedAt).toBeNull();
    });
  });

  describe('inspectAccessReset', () => {
    it('tells the holder of a live token when it ends and nothing else: no name, no address, no organisation', async () => {
      const person = await makeTarget();
      const made = await link(scene.ownerId, person);
      const before = await totals();
      const seen = await inspectAccessReset(
        db(),
        made.token,
        made.reset.createdAt,
      );
      expect(Object.keys(seen)).toEqual(['expiresAt']);
      expect(seen.expiresAt).toEqual(made.reset.expiresAt);
      // Nothing is written for a live token.
      expect(await totals()).toEqual(before);
      const [who] = await db().select().from(user).where(eq(user.id, person));
      const text = JSON.stringify(seen);
      expect(text).not.toContain(who!.email);
      expect(text).not.toContain(who!.displayName);
      expect(text).not.toContain(scene.organisationId);
    });

    it('answers every token that does not work with the one error, and says why only in the audit trail', async () => {
      const person = await makeTarget();
      const expired = await link(scene.ownerId, person, { expiresInHours: 1 });
      const revokedPerson = await makeTarget();
      const revoked = await link(scene.ownerId, revokedPerson);
      await revokeAccessReset(
        db(),
        { userId: scene.ownerId },
        scene.organisationId,
        revokedPerson,
        at(900 * MINUTE),
      );
      const usedPerson = await makeTarget();
      const used = await link(scene.ownerId, usedPerson);
      await db()
        .update(accessReset)
        .set({ usedAt: at(901 * MINUTE) })
        .where(eq(accessReset.id, used.reset.id));

      const when = at(1000 * HOUR);
      const cases: {
        name: string;
        token: unknown;
        reason: string;
        known: string | null;
      }[] = [
        {
          name: 'unknown',
          token: 'not-a-token-anyone-made',
          reason: 'unknown',
          known: null,
        },
        { name: 'empty', token: '', reason: 'unknown', known: null },
        {
          name: 'too long',
          token: 'x'.repeat(300),
          reason: 'unknown',
          known: null,
        },
        { name: 'not text', token: 12345, reason: 'unknown', known: null },
        {
          name: 'expired',
          token: expired.token,
          reason: 'expired',
          known: expired.reset.id,
        },
        {
          name: 'revoked',
          token: revoked.token,
          reason: 'revoked',
          known: revoked.reset.id,
        },
        {
          name: 'used',
          token: used.token,
          reason: 'used',
          known: used.reset.id,
        },
      ];
      const messages = new Set<string>();
      for (const found of cases) {
        const before = (await audits(AUTH_AUDIT.accessResetInspectFailed))
          .length;
        const error = await rejection(
          inspectAccessReset(db(), found.token as string, when),
        );
        expect(error, found.name).toBeInstanceOf(AccessResetInvalidError);
        messages.add((error as Error).message);
        expect((error as AccessResetInvalidError).reason, found.name).toBe(
          found.reason,
        );
        const events = (
          await audits(AUTH_AUDIT.accessResetInspectFailed)
        ).slice(before);
        expect(events, found.name).toHaveLength(1);
        expect(events[0], found.name).toMatchObject({
          action: 'inspect',
          actorType: 'system',
          actorId: null,
          targetType: found.known === null ? null : 'access_reset',
          targetId: found.known,
          details: { reason: found.reason },
        });
        // The message carries neither the token nor anything about the link
        // (an empty string is in every text, so it says nothing to look for).
        if (typeof found.token === 'string' && found.token.length > 0) {
          expect((error as Error).message).not.toContain(found.token);
        }
      }
      expect(messages.size).toBe(1);
    });

    it('refuses a link that a use would refuse, with the same error, so a page never shows a link as good that then fails', async () => {
      const messages = new Set<string>();
      const expectRefused = async (
        made: Awaited<ReturnType<typeof link>>,
        reason: string,
      ) => {
        const before = (await audits(AUTH_AUDIT.accessResetInspectFailed))
          .length;
        const error = await rejection(
          inspectAccessReset(db(), made.token, made.reset.createdAt),
        );
        expect(error, reason).toBeInstanceOf(AccessResetInvalidError);
        expect((error as AccessResetInvalidError).reason).toBe(reason);
        messages.add((error as Error).message);
        const [event] = (
          await audits(AUTH_AUDIT.accessResetInspectFailed)
        ).slice(before);
        expect(event, reason).toMatchObject({
          actorType: 'system',
          targetId: made.reset.id,
          details: { reason },
        });
        // Looking at a link changes nothing about it.
        const kept = await row(made.reset.id);
        expect(kept.usedAt).toBeNull();
        expect(kept.revokedAt).toBeNull();
      };

      const joined = await makeTarget();
      const afterJoining = await link(scene.ownerId, joined);
      await seedMembership(
        database,
        scene.otherOrganisationId,
        joined,
        'member',
        [],
      );
      await expectRefused(afterJoining, 'target-in-other-organisations');

      const disabled = await makeTarget();
      const afterDisabling = await link(scene.ownerId, disabled);
      await setUserStatus(database, disabled, 'disabled');
      await expectRefused(afterDisabling, 'target-not-active');

      const creator = await seedUser(database);
      await seedMembership(database, scene.organisationId, creator, 'member', [
        scene.roles.resetter,
      ]);
      const person = await makeTarget({ roleIds: [] });
      const fromCreator = await link(creator, person);
      await setUserStatus(database, creator, 'disabled');
      await expectRefused(fromCreator, 'creator-not-allowed');

      // One answer for all of them, and it is the one every other failure gets.
      expect(messages.size).toBe(1);
    });

    it('counts a link that ends at the moment asked as expired, as the cleanup does', async () => {
      const person = await makeTarget();
      const made = await link(scene.ownerId, person, { expiresInHours: 1 });
      await expect(
        inspectAccessReset(
          db(),
          made.token,
          new Date(made.reset.expiresAt.getTime() - 1),
        ),
      ).resolves.toEqual({ expiresAt: made.reset.expiresAt });
      await expect(
        inspectAccessReset(db(), made.token, made.reset.expiresAt),
      ).rejects.toMatchObject({ name: 'AccessResetInvalidError' });
    });
  });

  describe('cleanupAccessResets', () => {
    it('deletes the links that were used, revoked or have expired, with the cut-off the service counts by, and keeps the live ones', async () => {
      const now = at(2000 * HOUR);
      const live = await link(
        scene.ownerId,
        await makeTarget(),
        {},
        new Date(now.getTime() - HOUR),
      );
      const endsNow = await link(
        scene.ownerId,
        await makeTarget(),
        { expiresInHours: 1 },
        new Date(now.getTime() - HOUR),
      );
      const revokedPerson = await makeTarget();
      const revoked = await link(
        scene.ownerId,
        revokedPerson,
        {},
        new Date(now.getTime() - HOUR),
      );
      await revokeAccessReset(
        db(),
        { userId: scene.ownerId },
        scene.organisationId,
        revokedPerson,
        new Date(now.getTime() - 30 * MINUTE),
      );
      const used = await link(
        scene.ownerId,
        await makeTarget(),
        {},
        new Date(now.getTime() - HOUR),
      );
      await db()
        .update(accessReset)
        .set({ usedAt: new Date(now.getTime() - 20 * MINUTE) })
        .where(eq(accessReset.id, used.reset.id));
      const before = await totals();
      const removed = await cleanupAccessResets(db(), now);
      const after = await db().select().from(accessReset);
      // The three above, and every link of the tests before, which have all ended.
      expect(removed).toBeGreaterThanOrEqual(3);
      expect(after.length).toBe(before.links - removed);
      const ids = new Set(after.map((found) => found.id));
      expect(ids.has(live.reset.id)).toBe(true);
      for (const gone of [endsNow, revoked, used]) {
        expect(ids.has(gone.reset.id)).toBe(false);
      }
      // What is left is live: not used, not revoked, with time left.
      for (const found of after) {
        expect(found.usedAt).toBeNull();
        expect(found.revokedAt).toBeNull();
        expect(found.expiresAt.getTime()).toBeGreaterThan(now.getTime());
      }
      // Housekeeping writes no event of its own.
      expect((await totals()).events).toBe(before.events);
    });

    it('keeps a link while it is live, and removes it the moment it ends', async () => {
      const now = at(3000 * HOUR);
      const made = await link(
        scene.ownerId,
        await makeTarget(),
        { expiresInHours: 2 },
        now,
      );
      const exists = async () =>
        (await db().select().from(accessReset)).some(
          (found) => found.id === made.reset.id,
        );
      // Links of the tests before have ended by now and may go; this one has an
      // hour left.
      await cleanupAccessResets(db(), new Date(now.getTime() + HOUR));
      expect(await exists()).toBe(true);
      await cleanupAccessResets(db(), made.reset.expiresAt);
      expect(await exists()).toBe(false);
    });
  });

  describe('what the reset flows keep out of events and tables', () => {
    it('holds no token in any table or event, no hash in any event, and no address in any event', async () => {
      // Every flow above has run.
      expect(tokens.length).toBeGreaterThan(20);
      const stored = await everyRowAsText(database);
      const events = JSON.stringify(await db().select().from(auditEvent));
      const changes = JSON.stringify(await db().select().from(changeEvent));
      for (const token of tokens) {
        expect(stored, `table: ${token.slice(0, 4)}`).not.toContain(token);
        expect(events, `audit: ${token.slice(0, 4)}`).not.toContain(token);
        expect(changes, `change: ${token.slice(0, 4)}`).not.toContain(token);
        expect(events, `audit hash: ${token.slice(0, 4)}`).not.toContain(
          hashToken(token),
        );
        expect(changes, `change hash: ${token.slice(0, 4)}`).not.toContain(
          hashToken(token),
        );
      }
      // The hash is only ever in the link's own row: a new link has it there,
      // and the check above would be empty if it were somewhere else too.
      const fresh = await link(scene.ownerId, await makeTarget());
      expect(JSON.stringify(await db().select().from(accessReset))).toContain(
        hashToken(fresh.token),
      );
      const addresses = await db().select({ email: user.email }).from(user);
      for (const { email } of addresses) {
        expect(events, email).not.toContain(email);
        expect(changes, email).not.toContain(email);
      }
      expect(events).not.toContain(DEMO_ADMIN_EMAIL);
      // The other tables hold no hash of a reset token either.
      const memberships = JSON.stringify(
        await db().select().from(orgMembership),
      );
      for (const token of tokens) {
        expect(memberships).not.toContain(hashToken(token));
      }
    });
  });
});
