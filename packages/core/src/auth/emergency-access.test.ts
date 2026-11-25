import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  accessReset,
  auditEvent,
  installation,
  type OrgRole,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { ACCESS_RESET_LIFETIME } from './access-reset.js';
import type { AdminPerson } from './admin-report.js';
import { AuthInputError } from './errors.js';
import {
  EMERGENCY_ACCESS_DEFAULT_HOURS,
  issueEmergencyAccess,
  type EmergencyAccessInput,
  type EmergencyAccessResult,
} from './emergency-access.js';
import { AUTH_AUDIT } from './shared.js';
import {
  emailOf,
  everyRowAsText,
  markUserDeleted,
  seedInstallation,
  seedMembership,
  seedResetScene,
  setMembershipStatus,
  setUserStatus,
  type ResetScene,
} from './test-support.js';

/**
 * `issueEmergencyAccess`: what the admin command `emergency-access` asks of the
 * core (P-09a2, decision D-81). It finds the person and the organisation from what an
 * operator types, refuses with a reason the command turns into fixed words, and makes
 * the link through `createSystemAccessReset`, whose rules are in
 * `access-reset-system.test.ts`. A refusal writes one `admin.command-run` event; a
 * link written is audited by the reset's own event and by no other.
 */

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** The two ways an operator names a person: by the id of the account, or by the address typed. */
const byId = (userId: string): AdminPerson => ({ kind: 'user', userId });
const byEmail = (email: string): AdminPerson => ({ kind: 'email', email });

describe.each(testTargets)('issuing emergency access on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scene: ResetScene;
  let installationId: string;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    scene = await seedResetScene(database, T0);
    installationId = (await database.db.select().from(installation))[0]!.id;
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;

  let clock = 0;
  const issue = (input: EmergencyAccessInput): Promise<EmergencyAccessResult> =>
    issueEmergencyAccess(
      db(),
      input,
      new Date(T0.getTime() + (clock += 1) * MINUTE),
    );

  const audits = async (category: string) =>
    (await db().select().from(auditEvent))
      .filter((event) => event.category === category)
      .sort((a, b) => a.id.localeCompare(b.id));
  const adminRuns = async () => audits(AUTH_AUDIT.adminCommandRun);
  const links = async () => db().select().from(accessReset);

  /** A member of the organisation with `tier` and the roles given. */
  const member = async (
    tier: OrgRole,
    roleIds: readonly string[],
    options: {
      status?: 'active' | 'invited' | 'removed';
      deleted?: boolean;
    } = {},
  ) => {
    const userId = await seedUser(database);
    await seedMembership(
      database,
      scene.organisationId,
      userId,
      tier,
      roleIds,
      options,
    );
    return userId;
  };

  const rejection = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error('Expected the call to be refused, but it succeeded');
  };

  describe('finding the person', () => {
    it('finds them by id', async () => {
      const result = await issue({ person: byId(scene.ownerId) });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.reset.userId).toBe(scene.ownerId);
    });

    it('finds them by the address as typed: any case, with spaces around it', async () => {
      const email = await emailOf(database, scene.adminId);
      const result = await issue({
        person: byEmail(`  ${email.toUpperCase()}  `),
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.reset.userId).toBe(scene.adminId);
    });

    it.each([
      ['an address no one has', byEmail('nobody.here@example.test')],
      ['an id no one has', byId('01a21347-bb08-7167-bc54-000000000000')],
      ['text that is not an id', byId('not-an-id')],
      ['an empty address', byEmail('')],
    ])(
      'refuses %s as an unknown user, and says so in one event',
      async (_name, person) => {
        const before = (await adminRuns()).length;
        const links0 = (await links()).length;

        expect(await issue({ person })).toEqual({
          ok: false,
          reason: 'unknown-user',
        });

        expect(await links()).toHaveLength(links0);
        expect((await adminRuns()).length).toBe(before + 1);
      },
    );

    it('treats a deleted account as unknown', async () => {
      const person = await member('admin', [scene.roles.administrator]);
      await markUserDeleted(database, person, T0);
      expect(await issue({ person: byId(person) })).toEqual({
        ok: false,
        reason: 'unknown-user',
      });
      expect(
        await issue({ person: byEmail(await emailOf(database, person)) }),
      ).toEqual({ ok: false, reason: 'unknown-user' });
    });

    it.each([['disabled'], ['invited']] as const)(
      'refuses an account that is %s, before it asks which organisation',
      async (status) => {
        const person = await member('admin', [scene.roles.administrator]);
        // Two organisations: the organisation would be asked for, if the account
        // were not refused first.
        await seedMembership(
          database,
          scene.otherOrganisationId,
          person,
          'member',
          [],
        );
        await setUserStatus(database, person, status);
        expect(await issue({ person: byId(person) })).toEqual({
          ok: false,
          reason: 'user-not-active',
        });
      },
    );
  });

  describe('finding the organisation', () => {
    it('is the person’s only organisation when none is named', async () => {
      const result = await issue({ person: byId(scene.adminId) });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.reset.organisationId).toBe(scene.organisationId);
      }
    });

    it('is asked for when the person belongs to more than one, and then used', async () => {
      const person = await member('admin', [scene.roles.administrator]);
      await seedMembership(
        database,
        scene.otherOrganisationId,
        person,
        'owner',
        [],
      );
      const before = (await links()).length;

      expect(await issue({ person: byId(person) })).toEqual({
        ok: false,
        reason: 'organisation-required',
      });
      expect(await links()).toHaveLength(before);

      for (const organisationId of [
        scene.organisationId,
        scene.otherOrganisationId,
      ]) {
        const result = await issue({
          person: byId(person),
          organisationId,
        });
        expect(result.ok, organisationId).toBe(true);
        if (result.ok) expect(result.reset.organisationId).toBe(organisationId);
      }
    });

    it('counts a removed membership as a membership, and a deleted one as none', async () => {
      const removed = await member('admin', [scene.roles.administrator]);
      await seedMembership(
        database,
        scene.otherOrganisationId,
        removed,
        'member',
        [],
        { status: 'removed' },
      );
      expect(await issue({ person: byId(removed) })).toEqual({
        ok: false,
        reason: 'organisation-required',
      });

      const deleted = await member('admin', [scene.roles.administrator]);
      await seedMembership(
        database,
        scene.otherOrganisationId,
        deleted,
        'member',
        [],
        { deleted: true },
      );
      expect((await issue({ person: byId(deleted) })).ok).toBe(true);
    });

    it('refuses an organisation the person is not a member of, one that does not exist and text that is no id, in the same words', async () => {
      for (const organisationId of [
        scene.otherOrganisationId,
        '01a21347-bb08-7167-bc54-000000000000',
        'not-an-id',
      ]) {
        expect(
          await issue({ person: byId(scene.ownerId), organisationId }),
          organisationId,
        ).toEqual({ ok: false, reason: 'not-a-member' });
      }
    });

    it('refuses a person with no membership at all', async () => {
      const person = await seedUser(database);
      expect(await issue({ person: byId(person) })).toEqual({
        ok: false,
        reason: 'not-a-member',
      });
    });
  });

  describe('who may be given a link', () => {
    it.each([
      ['an owner', 'owner'],
      ['an administrator', 'admin'],
    ] as const)('gives a link to %s', async (_name, who) => {
      const person = who === 'owner' ? scene.ownerId : scene.adminId;
      const result = await issue({ person: byId(person) });
      expect(result.ok).toBe(true);
    });

    it.each([
      [
        'a plain member',
        () => Promise.resolve(scene.plainId),
        'not-an-administrator',
      ],
      [
        'a member who may make reset links',
        () => Promise.resolve(scene.resetterId),
        'not-an-administrator',
      ],
      [
        'a member of the tier admin with no Administrator role',
        () => member('admin', [scene.roles.crew]),
        'not-an-administrator',
      ],
      [
        'an owner whose membership was removed',
        () =>
          member('owner', [scene.roles.administrator], { status: 'removed' }),
        'membership-not-active',
      ],
      [
        'an administrator who is only invited',
        () =>
          member('admin', [scene.roles.administrator], { status: 'invited' }),
        'membership-not-active',
      ],
    ] as const)('refuses %s: %s', async (_name, who, reason) => {
      const person = await who();
      const before = (await links()).length;
      expect(await issue({ person: byId(person) })).toEqual({
        ok: false,
        reason,
      });
      expect(await links()).toHaveLength(before);
    });

    it('sees a membership that stopped being active', async () => {
      const person = await member('admin', [scene.roles.administrator]);
      await setMembershipStatus(
        database,
        scene.organisationId,
        person,
        'removed',
      );
      expect(await issue({ person: byId(person) })).toEqual({
        ok: false,
        reason: 'membership-not-active',
      });
    });
  });

  describe('the link', () => {
    it('lasts an hour unless asked for another number, from 1 to 72', async () => {
      expect(EMERGENCY_ACCESS_DEFAULT_HOURS).toBe(1);
      expect(ACCESS_RESET_LIFETIME.defaultHours).toBe(24);
      const now = new Date(T0.getTime() + 500 * HOUR);
      const person = byId(scene.adminId);

      const fresh = await issueEmergencyAccess(db(), { person }, now);
      const asked = await issueEmergencyAccess(
        db(),
        { person, expiresInHours: 72 },
        now,
      );

      if (!fresh.ok || !asked.ok) throw new Error('refused');
      expect(fresh.reset.expiresAt.getTime() - now.getTime()).toBe(HOUR);
      expect(asked.reset.expiresAt.getTime() - now.getTime()).toBe(72 * HOUR);
    });

    it('refuses another number of hours with an input error that names the field and never the value, and writes nothing', async () => {
      const before = JSON.stringify(await db().select().from(auditEvent));
      for (const expiresInHours of [0, 73, 1.5, -2]) {
        const error = await rejection(
          issue({ person: byId(scene.adminId), expiresInHours }),
        );
        expect(error).toBeInstanceOf(AuthInputError);
        expect((error as AuthInputError).field).toBe('expiresInHours');
        expect((error as Error).message).not.toContain(String(expiresInHours));
      }
      expect(JSON.stringify(await db().select().from(auditEvent))).toBe(before);
    });

    it('says whether using it revokes the passkeys', async () => {
      const kept = await issue({ person: byId(scene.adminId) });
      const removed = await issue({
        person: byId(scene.adminId),
        removePasskeys: true,
      });
      if (!kept.ok || !removed.ok) throw new Error('refused');
      expect(kept.reset.removePasskeys).toBe(false);
      expect(removed.reset.removePasskeys).toBe(true);
    });

    it('is the link of the system: no creator, and the token only in the answer', async () => {
      const result = await issue({ person: byId(scene.ownerId) });
      if (!result.ok) throw new Error('refused');
      const [stored] = await db()
        .select()
        .from(accessReset)
        .where(eq(accessReset.id, result.reset.id));
      expect(stored).toMatchObject({ createdBy: null, issuedBySystem: true });
      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await everyRowAsText(database)).not.toContain(result.token);
    });
  });

  describe('what is audited', () => {
    it('writes the reset’s own event for a link, from the system, and no admin.command-run', async () => {
      const runs = (await adminRuns()).length;
      const created = (await audits(AUTH_AUDIT.accessResetCreated)).length;

      const result = await issue({ person: byId(scene.ownerId) });
      if (!result.ok) throw new Error('refused');

      expect(await adminRuns()).toHaveLength(runs);
      const events = (await audits(AUTH_AUDIT.accessResetCreated)).slice(
        created,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorType: 'system',
        actorId: null,
        targetId: result.reset.id,
        details: { userId: scene.ownerId, issuedBySystem: true },
      });
    });

    it('writes one admin.command-run for a refusal: the command, the outcome and the reason, naming no one', async () => {
      const email = await emailOf(database, scene.plainId);
      const runs = (await adminRuns()).length;

      await issue({ person: byEmail(email) });

      const written = (await adminRuns()).slice(runs);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        action: 'run',
        actorType: 'system',
        actorId: null,
        targetType: 'installation',
        targetId: installationId,
        details: {
          command: 'emergency-access',
          outcome: 'refused',
          reason: 'not-an-administrator',
        },
      });
      const text = JSON.stringify(written);
      expect(text).not.toContain(email);
      expect(text).not.toContain(scene.plainId);
    });
  });

  describe('before anything else', () => {
    it('refuses while first-run setup is not complete', async () => {
      const fresh = await createMigratedDatabase(target);
      try {
        const freshInstallation = await seedInstallation(fresh.database);
        const user0 = await seedUser(fresh.database);

        expect(
          await issueEmergencyAccess(
            fresh.database.db,
            { person: byId(user0) },
            T0,
          ),
        ).toEqual({ ok: false, reason: 'setup-incomplete' });

        const [event] = await fresh.database.db.select().from(auditEvent);
        expect(event).toMatchObject({
          category: AUTH_AUDIT.adminCommandRun,
          targetId: freshInstallation,
          details: {
            command: 'emergency-access',
            outcome: 'refused',
            reason: 'setup-incomplete',
          },
        });
      } finally {
        await fresh.cleanup();
      }
    });

    it('refuses on a database that has no installation yet, and still writes its one event', async () => {
      const fresh = await createMigratedDatabase(target);
      try {
        expect(
          await issueEmergencyAccess(
            fresh.database.db,
            { person: byEmail('someone@example.test') },
            T0,
          ),
        ).toEqual({ ok: false, reason: 'installation-missing' });
        const [event] = await fresh.database.db.select().from(auditEvent);
        expect(event).toMatchObject({
          category: AUTH_AUDIT.adminCommandRun,
          targetType: null,
          targetId: null,
          details: { outcome: 'refused', reason: 'installation-missing' },
        });
      } finally {
        await fresh.cleanup();
      }
    });
  });
});
