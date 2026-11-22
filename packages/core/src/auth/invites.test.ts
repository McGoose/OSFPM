import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessDeniedError } from '../access/access-denied-error.js';
import {
  base,
  grantOnOrganisation,
  seedOrganisation,
  seedProject,
  seedUser,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  auditEvent,
  changeEvent,
  invite,
  orgMembership,
  orgMembershipRole,
  passwordCredential,
  role,
  rolePermission,
  user,
} from '../db/schema/index.js';
import { RecordNotFoundError, RecordWriteError } from '../db/write.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { completeFirstRunSetup } from './first-run-setup.js';
import {
  AccountExistsError,
  AlreadyMemberError,
  InviteEmailMismatchError,
  InviteExceedsOwnAccessError,
  InviteInvalidError,
  InvitePasswordRefusedError,
} from './invite-errors.js';
import {
  acceptInvite,
  createInvite,
  INVITE_LIFETIME,
  inspectInvite,
  listInvites,
  revokeInvite,
  type CreateInviteInput,
} from './invites.js';
import { AUTH_AUDIT } from './shared.js';
import {
  demoSetupInput,
  everyRowAsText,
  seedFirstRun,
  setUserStatus,
} from './test-support.js';
import { hashToken } from './tokens.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** Invented addresses, none of them real. */
const SAM = 'sam.demo@demopictures.example';
const ALEX = 'alex.demo@demopictures.example';
const NEW_PASSWORD = 'harbour-lantern-quiet-river';

describe.each(testTargets)('invites on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let organisationId: string;
  let adminId: string;
  let administratorRoleId: string;
  /** Holds `members:invite` and `accounts:read`, both in the organisation only. */
  let inviterId: string;
  let crewRoleId: string;
  let editorRoleId: string;
  let wideRoleId: string;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    const code = await seedFirstRun(database, T0);
    const done = await completeFirstRunSetup(
      database.db,
      demoSetupInput(code),
      T0,
    );
    if (!done.ok) throw new Error('the setup was refused');
    organisationId = done.organisation.id;
    adminId = done.user.id;
    const [administrator] = await database.db.select().from(role);
    administratorRoleId = administrator!.id;

    /** An organisation role with the grants given: `[key, reach]`. */
    const makeRole = async (
      key: string,
      grants: readonly (readonly [string, 'own-scope' | 'all-projects'])[],
    ) => {
      const [created] = await database.db
        .insert(role)
        .values({
          ...base(organisationId),
          projectId: null,
          key,
          name: key,
        })
        .returning();
      for (const [permissionKey, reach] of grants) {
        await database.db.insert(rolePermission).values({
          ...base(organisationId),
          roleId: created!.id,
          permissionKey,
          reach,
        });
      }
      return created!.id;
    };
    crewRoleId = await makeRole('crew', [['accounts:read', 'own-scope']]);
    editorRoleId = await makeRole('editor', [
      ['accounts:read', 'own-scope'],
      ['accounts:edit', 'own-scope'],
    ]);
    wideRoleId = await makeRole('wide', [['accounts:read', 'all-projects']]);
    inviterId = await seedUser(database);
    await grantOnOrganisation(
      database,
      organisationId,
      inviterId,
      'member',
      ['members:invite', 'accounts:read'],
      { reach: 'own-scope' },
    );
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;
  const admin = () => ({ userId: adminId });

  /** Makes an invite as the administrator, at a time of its own so the order is clear. */
  let clock = 10;
  const make = (
    input: Partial<CreateInviteInput> = {},
    actor: { userId: string } = admin(),
  ) =>
    createInvite(
      db(),
      actor,
      organisationId,
      { tier: 'member', roleIds: [crewRoleId], ...input },
      at((clock += 1) * MINUTE),
    );
  const audits = async (category: string) =>
    (await db().select().from(auditEvent)).filter(
      (event) => event.category === category,
    );
  const inviteRow = async (id: string) =>
    (await db().select().from(invite).where(eq(invite.id, id)))[0]!;
  const countOf = async (table: 'user' | 'org_membership' | 'invite') =>
    Number(
      (
        (await db().execute(
          sql`select count(*)::int as n from ${sql.identifier(table)}`,
        )) as { rows: { n: number }[] }
      ).rows[0]!.n,
    );

  describe('createInvite', () => {
    it('makes an invite and returns it with its token: 43 base64url characters, shown once', async () => {
      const made = await make({
        email: ALEX,
        roleIds: [crewRoleId, editorRoleId],
      });
      expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(made.invite).toMatchObject({
        organisationId,
        email: ALEX,
        tier: 'member',
        createdBy: adminId,
      });
      expect([...made.invite.roleIds].sort()).toEqual(
        [crewRoleId, editorRoleId].sort(),
      );
      expect(
        made.invite.expiresAt.getTime() - made.invite.createdAt.getTime(),
      ).toBe(INVITE_LIFETIME.defaultDays * DAY);
      // The view has no hash and no token.
      expect(Object.keys(made.invite).sort()).toEqual(
        [
          'createdAt',
          'createdBy',
          'email',
          'expiresAt',
          'id',
          'organisationId',
          'roleIds',
          'tier',
        ].sort(),
      );
    });

    it('stores only the hash of the token, in no table and no event as the token', async () => {
      const made = await make();
      const row = await inviteRow(made.invite.id);
      expect(row.tokenHash).toBe(hashToken(made.token));
      expect(await everyRowAsText(database)).not.toContain(made.token);
      expect(
        JSON.stringify(await db().select().from(auditEvent)),
      ).not.toContain(made.token);
      expect(
        JSON.stringify(await db().select().from(changeEvent)),
      ).not.toContain(made.token);
    });

    it('lasts the days asked for, from 1 to 30, and refuses any other number', async () => {
      for (const days of [1, 30]) {
        const made = await make({ expiresInDays: days });
        expect(
          made.invite.expiresAt.getTime() - made.invite.createdAt.getTime(),
        ).toBe(days * DAY);
      }
      for (const days of [0, 31, -1, 1.5, Number.NaN, 100]) {
        await expect(
          make({ expiresInDays: days }),
          String(days),
        ).rejects.toMatchObject({
          name: 'AuthInputError',
          field: 'expiresInDays',
        });
      }
    });

    it('refuses the owner tier and any tier that is not on the list, naming the field', async () => {
      for (const tier of ['owner', 'superuser', '']) {
        await expect(make({ tier: tier as never }), tier).rejects.toMatchObject(
          {
            name: 'AuthInputError',
            field: 'tier',
          },
        );
      }
      for (const tier of ['admin', 'member', 'supervisor', 'guest'] as const) {
        await make({ tier, roleIds: [] });
      }
    });

    it('keeps the address in the form user.email has, and refuses one that is not shaped like an address', async () => {
      const made = await make({ email: '  Sam.Demo@DemoPictures.example ' });
      expect(made.invite.email).toBe(SAM);
      for (const email of ['', 'no-at-sign', 'two@@signs', 'a b@c.d']) {
        await expect(make({ email }), email).rejects.toMatchObject({
          name: 'AuthInputError',
          field: 'email',
        });
      }
    });

    it('needs members:invite in the organisation, and answers a stranger as it answers a member without it', async () => {
      const outsider = await seedUser(database);
      const bystander = await seedUser(database);
      await grantOnOrganisation(database, organisationId, bystander, 'guest', [
        'members:read',
      ]);
      for (const userId of [outsider, bystander]) {
        const error = await make({}, { userId }).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(AccessDeniedError);
        // Named by id, so no scope: the answer never says which it was.
        expect((error as AccessDeniedError).scope).toBeUndefined();
      }
    });

    it('refuses a role that carries a permission the person making it lacks, lists the keys, and makes nothing', async () => {
      const invites = await countOf('invite');
      const error = await make(
        { roleIds: [crewRoleId, editorRoleId] },
        { userId: inviterId },
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(InviteExceedsOwnAccessError);
      expect((error as InviteExceedsOwnAccessError).permissions).toEqual([
        'accounts:edit',
      ]);
      // Nothing was made: no invite, and no event for one.
      expect(await countOf('invite')).toBe(invites);
    });

    it('refuses an all-projects grant when the person holds the permission for the organisation only', async () => {
      await expect(
        make({ roleIds: [wideRoleId] }, { userId: inviterId }),
      ).rejects.toMatchObject({
        name: 'InviteExceedsOwnAccessError',
        permissions: ['accounts:read'],
      });
    });

    it('lets the person give what they hold, at the same reach', async () => {
      const made = await make({ roleIds: [crewRoleId] }, { userId: inviterId });
      expect(made.invite.createdBy).toBe(inviterId);
    });

    it('lets the administrator, who holds every permission wide, give any role, the managed one included', async () => {
      const made = await make({
        roleIds: [administratorRoleId, wideRoleId, editorRoleId],
      });
      expect(made.invite.roleIds).toHaveLength(3);
    });

    it('makes no exception for an owner: a tier grants nothing, so an owner without the permission is refused', async () => {
      const owner = await seedUser(database);
      // Tier `owner`, and a role that holds only the right to invite.
      await grantOnOrganisation(database, organisationId, owner, 'owner', [
        'members:invite',
      ]);
      await expect(
        make({ roleIds: [crewRoleId] }, { userId: owner }),
      ).rejects.toMatchObject({
        name: 'InviteExceedsOwnAccessError',
        permissions: ['accounts:read'],
      });
    });

    it('refuses a role of another organisation, a project role, a deleted role and one that is not there, all alike', async () => {
      const other = await seedOrganisation(database);
      const [foreign] = await db()
        .insert(role)
        .values({
          ...base(other.organisationId),
          projectId: null,
          key: 'crew',
          name: 'Crew',
        })
        .returning();
      const projectId = await seedProject(database, organisationId);
      const [projectRole] = await db()
        .insert(role)
        .values({
          ...base(organisationId),
          projectId,
          key: 'gaffer',
          name: 'Gaffer',
        })
        .returning();
      const [deleted] = await db()
        .insert(role)
        .values({
          ...base(organisationId),
          projectId: null,
          key: 'gone',
          name: 'Gone',
          deletedAt: T0,
        })
        .returning();
      for (const roleId of [
        foreign!.id,
        projectRole!.id,
        deleted!.id,
        newId(),
      ]) {
        await expect(make({ roleIds: [roleId] }), roleId).rejects.toMatchObject(
          {
            name: 'AuthInputError',
            field: 'roleIds',
          },
        );
      }
      // Not a UUID at all.
      await expect(make({ roleIds: ['x'] })).rejects.toMatchObject({
        field: 'roleIds',
      });
    });

    it('counts a role given twice once', async () => {
      const made = await make({ roleIds: [crewRoleId, crewRoleId] });
      expect(made.invite.roleIds).toEqual([crewRoleId]);
    });

    it('audits it with the ids, the tier, the roles, the expiry and whether an address is set, and never the address or the token', async () => {
      const made = await make({ email: ALEX, expiresInDays: 2 });
      const [event] = (await audits(AUTH_AUDIT.inviteCreated)).filter(
        (found) => found.targetId === made.invite.id,
      );
      expect(event).toMatchObject({
        action: 'create',
        actorType: 'user',
        actorId: adminId,
        targetType: 'invite',
        organisationId,
        details: {
          tier: 'member',
          roleIds: crewRoleId,
          hasEmail: true,
          expiresAt: made.invite.expiresAt.toISOString(),
        },
      });
      const text = JSON.stringify(event);
      expect(text).not.toContain(ALEX);
      expect(text).not.toContain(made.token);
      expect(text).not.toContain(hashToken(made.token));
    });
  });

  describe('listInvites and revokeInvite', () => {
    it('lists the invites that can still be used, newest first, and never a token or a hash', async () => {
      const first = await make({ roleIds: [crewRoleId, editorRoleId] });
      const second = await make({ roleIds: [] });
      const listed = await listInvites(
        db(),
        admin(),
        organisationId,
        at(200 * MINUTE),
      );
      const ids = listed.map((found) => found.id);
      expect(ids.indexOf(second.invite.id)).toBeLessThan(
        ids.indexOf(first.invite.id),
      );
      const found = listed.find((entry) => entry.id === first.invite.id)!;
      expect([...found.roleIds].sort()).toEqual(
        [crewRoleId, editorRoleId].sort(),
      );
      const text = JSON.stringify(listed);
      expect(text).not.toContain(first.token);
      expect(text).not.toContain(hashToken(first.token));
      expect(text).not.toContain('tokenHash');
    });

    it('leaves out an invite that is used, revoked or expired', async () => {
      const used = await make();
      await acceptInvite(
        db(),
        used.token,
        {
          kind: 'new-account',
          account: {
            email: 'used.one@demopictures.example',
            displayName: 'Used One',
          },
        },
        at(300 * MINUTE),
      );
      const revoked = await make();
      await revokeInvite(
        db(),
        admin(),
        organisationId,
        revoked.invite.id,
        at(301 * MINUTE),
      );
      const short = await make({ expiresInDays: 1 });
      const live = await make();
      const now = at(302 * MINUTE);
      const before = (
        await listInvites(db(), admin(), organisationId, now)
      ).map((entry) => entry.id);
      expect(before).toContain(short.invite.id);
      expect(before).toContain(live.invite.id);
      expect(before).not.toContain(used.invite.id);
      expect(before).not.toContain(revoked.invite.id);
      // A day and a bit later the short one has expired.
      const later = (
        await listInvites(
          db(),
          admin(),
          organisationId,
          new Date(short.invite.expiresAt.getTime()),
        )
      ).map((entry) => entry.id);
      expect(later).not.toContain(short.invite.id);
    });

    it('lists only this organisation’s invites', async () => {
      const other = await seedOrganisation(database);
      await db()
        .insert(invite)
        .values({
          originServer: base(other.organisationId).originServer,
          organisationId: other.organisationId,
          tokenHash: `other-${newId()}`,
          tier: 'member',
          createdAt: T0,
          expiresAt: at(30 * DAY),
        });
      const listed = await listInvites(
        db(),
        admin(),
        organisationId,
        at(400 * MINUTE),
      );
      expect(
        listed.every((entry) => entry.organisationId === organisationId),
      ).toBe(true);
    });

    it('needs members:invite to list and to revoke', async () => {
      const outsider = await seedUser(database);
      await expect(
        listInvites(
          db(),
          { userId: outsider },
          organisationId,
          at(400 * MINUTE),
        ),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      const made = await make();
      await expect(
        revokeInvite(
          db(),
          { userId: outsider },
          organisationId,
          made.invite.id,
          at(400 * MINUTE),
        ),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      expect((await inviteRow(made.invite.id)).revokedAt).toBeNull();
    });

    it('revokes an invite, audits it, and then the link no longer works', async () => {
      const made = await make();
      await revokeInvite(
        db(),
        admin(),
        organisationId,
        made.invite.id,
        at(401 * MINUTE),
      );
      const row = await inviteRow(made.invite.id);
      expect(row.revokedAt).toEqual(at(401 * MINUTE));
      expect(row.revokedBy).toBe(adminId);
      expect(row.version).toBe(2);
      const [event] = (await audits(AUTH_AUDIT.inviteRevoked)).filter(
        (found) => found.targetId === made.invite.id,
      );
      expect(event).toMatchObject({
        action: 'revoke',
        actorType: 'user',
        actorId: adminId,
        organisationId,
      });
      await expect(
        acceptInvite(
          db(),
          made.token,
          {
            kind: 'new-account',
            account: {
              email: 'late@demopictures.example',
              displayName: 'Late',
            },
          },
          at(402 * MINUTE),
        ),
      ).rejects.toBeInstanceOf(InviteInvalidError);
    });

    it('answers a revoke of an invite that is not live, another organisation’s, or not there, with one RecordNotFoundError', async () => {
      const made = await make();
      await revokeInvite(
        db(),
        admin(),
        organisationId,
        made.invite.id,
        at(403 * MINUTE),
      );
      const other = await seedOrganisation(database);
      const [foreign] = await db()
        .insert(invite)
        .values({
          originServer: base(other.organisationId).originServer,
          organisationId: other.organisationId,
          tokenHash: `foreign-${newId()}`,
          tier: 'member',
          createdAt: T0,
          expiresAt: at(30 * DAY),
        })
        .returning();
      for (const id of [made.invite.id, foreign!.id, newId(), 'not-a-uuid']) {
        await expect(
          revokeInvite(db(), admin(), organisationId, id, at(404 * MINUTE)),
          id,
        ).rejects.toBeInstanceOf(RecordNotFoundError);
      }
      expect((await inviteRow(foreign!.id)).revokedAt).toBeNull();
    });
  });

  describe('inspectInvite', () => {
    it('tells the holder of a live token the organisation, the end and whether an address is needed, and writes nothing', async () => {
      const open = await make();
      const named = await make({ email: SAM });
      const events = (await db().select().from(auditEvent)).length;
      expect(await inspectInvite(db(), open.token, at(500 * MINUTE))).toEqual({
        organisationName: 'Demo Pictures',
        expiresAt: open.invite.expiresAt,
        emailRequired: false,
      });
      const inspection = await inspectInvite(
        db(),
        named.token,
        at(500 * MINUTE),
      );
      expect(inspection.emailRequired).toBe(true);
      // Which address is not said.
      expect(JSON.stringify(inspection)).not.toContain(SAM);
      expect((await db().select().from(auditEvent)).length).toBe(events);
    });

    it('answers every kind of token that is no good with one and the same error', async () => {
      const used = await make();
      await acceptInvite(
        db(),
        used.token,
        {
          kind: 'new-account',
          account: {
            email: 'inspect.used@demopictures.example',
            displayName: 'Used',
          },
        },
        at(501 * MINUTE),
      );
      const revoked = await make();
      await revokeInvite(
        db(),
        admin(),
        organisationId,
        revoked.invite.id,
        at(502 * MINUTE),
      );
      const expired = await make({ expiresInDays: 1 });
      const causes = new Map<string, string>();
      for (const [name, token, now] of [
        ['unknown', 'a-token-nobody-made', at(503 * MINUTE)],
        ['empty', '', at(503 * MINUTE)],
        ['too long', 'x'.repeat(1000), at(503 * MINUTE)],
        ['used', used.token, at(503 * MINUTE)],
        ['revoked', revoked.token, at(503 * MINUTE)],
        [
          'expired',
          expired.token,
          new Date(expired.invite.expiresAt.getTime()),
        ],
      ] as const) {
        const error = await inspectInvite(db(), token, now).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(error, name).toBeInstanceOf(InviteInvalidError);
        causes.set(
          name,
          `${(error as Error).name}: ${(error as Error).message}`,
        );
      }
      // One answer, whatever the cause.
      expect(new Set(causes.values()).size).toBe(1);
    });

    it('audits each failure with the cause and the invite id when there is one, from the system, and never the token', async () => {
      const made = await make();
      await revokeInvite(
        db(),
        admin(),
        organisationId,
        made.invite.id,
        at(510 * MINUTE),
      );
      const before = (await audits(AUTH_AUDIT.inviteInspectFailed)).length;
      await expect(
        inspectInvite(db(), made.token, at(511 * MINUTE)),
      ).rejects.toBeInstanceOf(InviteInvalidError);
      await expect(
        inspectInvite(db(), 'a-token-nobody-made-2', at(511 * MINUTE)),
      ).rejects.toBeInstanceOf(InviteInvalidError);
      const events = (await audits(AUTH_AUDIT.inviteInspectFailed)).slice(
        before,
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        action: 'inspect',
        actorType: 'system',
        actorId: null,
        targetType: 'invite',
        targetId: made.invite.id,
        organisationId,
        details: { reason: 'revoked' },
      });
      expect(events[1]).toMatchObject({
        targetType: null,
        targetId: null,
        organisationId: null,
        details: { reason: 'unknown' },
      });
      const text = JSON.stringify(events);
      expect(text).not.toContain(made.token);
      expect(text).not.toContain('a-token-nobody-made-2');
      expect(text).not.toContain(hashToken(made.token));
    });
  });

  describe('acceptInvite by a new account', () => {
    const newcomer = (email: string, extra: { password?: string } = {}) =>
      ({
        kind: 'new-account',
        account: { email, displayName: 'Sam Demo', ...extra },
      }) as const;

    it('makes the user, the membership with the tier and the roles, and marks the invite used', async () => {
      const made = await make({
        tier: 'supervisor',
        roleIds: [crewRoleId, editorRoleId],
      });
      const accepted = await acceptInvite(
        db(),
        made.token,
        newcomer('Newcomer.One@DemoPictures.example', {
          password: NEW_PASSWORD,
        }),
        at(600 * MINUTE),
      );
      expect(accepted).toMatchObject({
        newUser: true,
        mustSecureAccount: false,
        organisation: { id: organisationId, name: 'Demo Pictures' },
        user: {
          email: 'newcomer.one@demopictures.example',
          displayName: 'Sam Demo',
          status: 'active',
          locale: 'en-GB',
          timezone: 'Europe/London',
        },
      });
      const [membership] = (await db().select().from(orgMembership)).filter(
        (found) => found.userId === accepted.user.id,
      );
      expect(membership).toMatchObject({
        organisationId,
        orgRole: 'supervisor',
        status: 'active',
        createdBy: accepted.user.id,
      });
      const linked = (await db().select().from(orgMembershipRole))
        .filter((link) => link.membershipId === membership!.id)
        .map((link) => link.roleId)
        .sort();
      expect(linked).toEqual([crewRoleId, editorRoleId].sort());
      const row = await inviteRow(made.invite.id);
      expect(row.usedAt).toEqual(at(600 * MINUTE));
      expect(row.usedBy).toBe(accepted.user.id);
      // The password was set, as a hash.
      expect(
        (await db().select().from(passwordCredential)).some(
          (credential) => credential.userId === accepted.user.id,
        ),
      ).toBe(true);
      expect(await everyRowAsText(database)).not.toContain(NEW_PASSWORD);
    });

    it('logs the membership and the roles as changes of the organisation, by the new user', async () => {
      const made = await make({ roleIds: [crewRoleId] });
      const accepted = await acceptInvite(
        db(),
        made.token,
        newcomer('change.log@demopictures.example'),
        at(601 * MINUTE),
      );
      const changes = (await db().select().from(changeEvent)).filter(
        (event) => event.actorId === accepted.user.id,
      );
      expect(changes.map((event) => event.entityType).sort()).toEqual([
        'org_membership',
        'org_membership_role',
      ]);
      for (const event of changes) {
        expect(event).toMatchObject({
          organisationId,
          projectId: null,
          action: 'create',
          actorType: 'user',
        });
      }
    });

    it('answers an account with no password as one that must be secured first', async () => {
      const made = await make();
      const accepted = await acceptInvite(
        db(),
        made.token,
        newcomer('no.password@demopictures.example'),
        at(602 * MINUTE),
      );
      expect(accepted.mustSecureAccount).toBe(true);
      expect(
        (await db().select().from(passwordCredential)).some(
          (credential) => credential.userId === accepted.user.id,
        ),
      ).toBe(false);
    });

    it('audits it as accepted, with the invite, the user and that the account is new, and never an address or a password', async () => {
      const made = await make({ email: SAM });
      const accepted = await acceptInvite(
        db(),
        made.token,
        newcomer(SAM, { password: NEW_PASSWORD }),
        at(603 * MINUTE),
      );
      const [event] = (await audits(AUTH_AUDIT.inviteAccepted)).filter(
        (found) => found.targetId === made.invite.id,
      );
      expect(event).toMatchObject({
        action: 'accept',
        actorType: 'user',
        actorId: accepted.user.id,
        organisationId,
        details: { userId: accepted.user.id, newUser: true },
      });
      const text = JSON.stringify(await db().select().from(auditEvent));
      expect(text).not.toContain(SAM);
      expect(text).not.toContain(NEW_PASSWORD);
      expect(text).not.toContain(made.token);
    });

    it('takes an address in another case when the invite names one', async () => {
      const made = await make({ email: ALEX });
      const accepted = await acceptInvite(
        db(),
        made.token,
        newcomer('  ALEX.demo@DEMOPICTURES.example '),
        at(604 * MINUTE),
      );
      expect(accepted.user.email).toBe(ALEX);
    });

    it('refuses another address when the invite names one, leaves the invite live and makes nothing', async () => {
      const made = await make({ email: 'named@demopictures.example' });
      const users = await countOf('user');
      const memberships = await countOf('org_membership');
      await expect(
        acceptInvite(
          db(),
          made.token,
          newcomer('someone.else@demopictures.example'),
          at(605 * MINUTE),
        ),
      ).rejects.toBeInstanceOf(InviteEmailMismatchError);
      expect(await countOf('user')).toBe(users);
      expect(await countOf('org_membership')).toBe(memberships);
      expect((await inviteRow(made.invite.id)).usedAt).toBeNull();
      const [event] = (await audits(AUTH_AUDIT.inviteAcceptRefused)).filter(
        (found) => found.targetId === made.invite.id,
      );
      expect(event).toMatchObject({
        actorType: 'system',
        organisationId,
        details: { reason: 'email-mismatch' },
      });
      expect(JSON.stringify(event)).not.toContain('someone.else');
    });

    it('refuses an address that already has an account, leaves the invite live, and audits the reason', async () => {
      const made = await make();
      const users = await countOf('user');
      await expect(
        acceptInvite(
          db(),
          made.token,
          newcomer(DEMO_ADMIN_EMAIL_LOWER),
          at(606 * MINUTE),
        ),
      ).rejects.toBeInstanceOf(AccountExistsError);
      expect(await countOf('user')).toBe(users);
      expect((await inviteRow(made.invite.id)).usedAt).toBeNull();
      const [event] = (await audits(AUTH_AUDIT.inviteAcceptRefused)).filter(
        (found) => found.targetId === made.invite.id,
      );
      expect(event!.details).toEqual({ reason: 'account-exists' });
    });

    it('refuses a password the policy refuses, with the reason, and undoes everything: no user, the invite live', async () => {
      const made = await make();
      const users = await countOf('user');
      const error = await acceptInvite(
        db(),
        made.token,
        newcomer('short.password@demopictures.example', { password: 'short' }),
        at(607 * MINUTE),
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(InvitePasswordRefusedError);
      expect((error as InvitePasswordRefusedError).refusal).toBe('too-short');
      expect(await countOf('user')).toBe(users);
      expect((await inviteRow(made.invite.id)).usedAt).toBeNull();
      // No secret was guessed, so it is not audited.
      expect(
        (await audits(AUTH_AUDIT.inviteAcceptRefused)).filter(
          (found) => found.targetId === made.invite.id,
        ),
      ).toEqual([]);
      // ... and the same invite still works with a better one.
      await acceptInvite(
        db(),
        made.token,
        newcomer('short.password@demopictures.example', {
          password: NEW_PASSWORD,
        }),
        at(608 * MINUTE),
      );
    });

    it('undoes the user, the used mark and the audit event when a step after the user fails', async () => {
      const made = await make();
      const users = await countOf('user');
      const memberships = await countOf('org_membership');
      const accepted = (await audits(AUTH_AUDIT.inviteAccepted)).length;
      const created = (await audits(AUTH_AUDIT.userCreated)).length;
      // Makes the membership insert fail, after the user exists.
      await db().execute(
        sql`create function osfpm_test_refuse_membership() returns trigger language plpgsql as $$ begin raise exception 'forced failure'; end; $$`,
      );
      await db().execute(
        sql`create trigger osfpm_test_refuse_membership before insert on org_membership for each row execute function osfpm_test_refuse_membership()`,
      );
      try {
        await expect(
          acceptInvite(
            db(),
            made.token,
            newcomer('rolled.back@demopictures.example', {
              password: NEW_PASSWORD,
            }),
            at(609 * MINUTE),
          ),
        ).rejects.toBeInstanceOf(RecordWriteError);
      } finally {
        await db().execute(
          sql`drop trigger osfpm_test_refuse_membership on org_membership`,
        );
        await db().execute(sql`drop function osfpm_test_refuse_membership()`);
      }
      expect(await countOf('user')).toBe(users);
      expect(await countOf('org_membership')).toBe(memberships);
      expect((await inviteRow(made.invite.id)).usedAt).toBeNull();
      expect((await audits(AUTH_AUDIT.inviteAccepted)).length).toBe(accepted);
      expect((await audits(AUTH_AUDIT.userCreated)).length).toBe(created);
      // Nothing is left of the password either.
      expect(await everyRowAsText(database)).not.toContain(
        'rolled.back@demopictures.example',
      );
    });

    it('refuses a used invite, an expired one and an unknown token with the same error, and audits the cause', async () => {
      const made = await make({ expiresInDays: 1 });
      await acceptInvite(
        db(),
        made.token,
        newcomer('first.in@demopictures.example'),
        at(610 * MINUTE),
      );
      const errors: Error[] = [];
      for (const [token, now] of [
        [made.token, at(611 * MINUTE)],
        ['a-token-nobody-made-3', at(611 * MINUTE)],
      ] as const) {
        const error = await acceptInvite(
          db(),
          token,
          newcomer('late.one@demopictures.example'),
          now,
        ).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(InviteInvalidError);
        errors.push(error as Error);
      }
      const expired = await make({ expiresInDays: 1 });
      const lateError = await acceptInvite(
        db(),
        expired.token,
        newcomer('late.two@demopictures.example'),
        new Date(expired.invite.expiresAt.getTime()),
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      errors.push(lateError as Error);
      expect(
        new Set(errors.map((error) => `${error.name}: ${error.message}`)).size,
      ).toBe(1);
      const reasons = (await audits(AUTH_AUDIT.inviteAcceptRefused))
        .filter(
          (found) =>
            found.targetId === made.invite.id ||
            found.targetId === expired.invite.id,
        )
        .map((found) => (found.details as { reason: string }).reason)
        .sort();
      expect(reasons).toEqual(['expired', 'used']);
    });

    it('refuses an account whose email or name is not acceptable before it reads anything, naming the field', async () => {
      const made = await make();
      for (const [account, field] of [
        [{ email: 'not an address', displayName: 'X' }, 'account.email'],
        [
          { email: 'ok@demopictures.example', displayName: '   ' },
          'account.displayName',
        ],
        [
          { email: 'ok@demopictures.example', displayName: 'x'.repeat(201) },
          'account.displayName',
        ],
      ] as const) {
        await expect(
          acceptInvite(
            db(),
            made.token,
            { kind: 'new-account', account },
            at(612 * MINUTE),
          ),
        ).rejects.toMatchObject({ name: 'AuthInputError', field });
      }
      expect((await inviteRow(made.invite.id)).usedAt).toBeNull();
    });
  });

  describe('acceptInvite by a signed-in user', () => {
    const signedIn = (userId: string) =>
      ({ kind: 'signed-in', userId }) as const;

    it('makes the membership with the tier and the roles for the user, who keeps their account', async () => {
      const userId = await seedUser(database);
      const made = await make({ tier: 'guest', roleIds: [crewRoleId] });
      const accepted = await acceptInvite(
        db(),
        made.token,
        signedIn(userId),
        at(700 * MINUTE),
      );
      expect(accepted).toMatchObject({
        newUser: false,
        mustSecureAccount: false,
        user: { id: userId },
        organisation: { id: organisationId },
      });
      const [membership] = (await db().select().from(orgMembership)).filter(
        (found) => found.userId === userId,
      );
      expect(membership).toMatchObject({ orgRole: 'guest', status: 'active' });
      const [event] = (await audits(AUTH_AUDIT.inviteAccepted)).filter(
        (found) => found.targetId === made.invite.id,
      );
      expect(event).toMatchObject({
        actorId: userId,
        details: { userId, newUser: false },
      });
    });

    it('refuses a user who is already a member, and leaves the invite live', async () => {
      const userId = await seedUser(database);
      await grantOnOrganisation(database, organisationId, userId, 'member', []);
      const made = await make();
      await expect(
        acceptInvite(db(), made.token, signedIn(userId), at(701 * MINUTE)),
      ).rejects.toBeInstanceOf(AlreadyMemberError);
      expect((await inviteRow(made.invite.id)).usedAt).toBeNull();
      const [event] = (await audits(AUTH_AUDIT.inviteAcceptRefused)).filter(
        (found) => found.targetId === made.invite.id,
      );
      expect(event).toMatchObject({
        actorType: 'user',
        actorId: userId,
        details: { reason: 'already-member' },
      });
    });

    it('refuses a user whose address is not the one the invite names, and accepts the one it does', async () => {
      const made = await make({ email: 'named.user@demopictures.example' });
      const wrong = await seedUser(database);
      await expect(
        acceptInvite(db(), made.token, signedIn(wrong), at(702 * MINUTE)),
      ).rejects.toBeInstanceOf(InviteEmailMismatchError);
      expect((await inviteRow(made.invite.id)).usedAt).toBeNull();
      const right = await seedUser(database);
      await db()
        .update(user)
        .set({ email: 'named.user@demopictures.example' })
        .where(eq(user.id, right));
      await acceptInvite(db(), made.token, signedIn(right), at(703 * MINUTE));
      expect((await inviteRow(made.invite.id)).usedBy).toBe(right);
    });

    it('refuses a user who is not active, or not there, with a state error and leaves the invite live', async () => {
      const made = await make();
      const waiting = await seedUser(database);
      await setUserStatus(database, waiting, 'invited');
      await expect(
        acceptInvite(db(), made.token, signedIn(waiting), at(704 * MINUTE)),
      ).rejects.toMatchObject({
        name: 'AuthStateError',
        reason: 'user-disabled',
      });
      await expect(
        acceptInvite(db(), made.token, signedIn(newId()), at(704 * MINUTE)),
      ).rejects.toMatchObject({
        name: 'AuthStateError',
        reason: 'user-not-found',
      });
      expect((await inviteRow(made.invite.id)).usedAt).toBeNull();
    });

    it('refuses a value that is not a user id before it reads anything', async () => {
      const made = await make();
      await expect(
        acceptInvite(
          db(),
          made.token,
          signedIn('not-a-uuid'),
          at(705 * MINUTE),
        ),
      ).rejects.toMatchObject({ name: 'AuthInputError', field: 'userId' });
    });

    it('leaves a role that was deleted since the invite was made off the membership', async () => {
      const [fleeting] = await db()
        .insert(role)
        .values({
          ...base(organisationId),
          projectId: null,
          key: 'fleeting',
          name: 'Fleeting',
        })
        .returning();
      const made = await make({ roleIds: [crewRoleId, fleeting!.id] });
      await db()
        .update(role)
        .set({ deletedAt: at(706 * MINUTE) })
        .where(eq(role.id, fleeting!.id));
      const userId = await seedUser(database);
      await acceptInvite(db(), made.token, signedIn(userId), at(707 * MINUTE));
      const [membership] = (await db().select().from(orgMembership)).filter(
        (found) => found.userId === userId,
      );
      expect(
        (await db().select().from(orgMembershipRole))
          .filter((link) => link.membershipId === membership!.id)
          .map((link) => link.roleId),
      ).toEqual([crewRoleId]);
    });
  });

  it('keeps every raw token, password and address an invite carried out of every audit event and change event', async () => {
    const text = JSON.stringify([
      await db().select().from(auditEvent),
      await db().select().from(changeEvent),
    ]);
    for (const secret of [
      NEW_PASSWORD,
      SAM,
      ALEX,
      'someone.else',
      'short.password',
      'rolled.back',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });
});

/** The first administrator's address, as `demoSetupInput` gives it, which has an account already. */
const DEMO_ADMIN_EMAIL_LOWER = 'ada.demo@demopictures.example';
