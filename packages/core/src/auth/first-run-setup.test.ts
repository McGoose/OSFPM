import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSION_LISTS } from '../access/permission-lists.js';
import type { Database } from '../db/client.js';
import {
  auditEvent,
  changeEvent,
  changeSeq,
  installation,
  organisation,
  orgMembership,
  orgMembershipRole,
  passwordCredential,
  role,
  session,
  setupCode,
  user,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { ADMINISTRATOR_ROLE_KEY } from './administrator-role.js';
import {
  normaliseLocale,
  normaliseTimeZone,
  completeFirstRunSetup,
  SETUP_ORGANISATION_DEFAULTS,
  slugFromName,
  type FirstRunSetupInput,
} from './first-run-setup.js';
import { verifyPasswordLogin } from './password-service.js';
import {
  checkSetupCode,
  consumeSetupCode,
  isSetupComplete,
  issueSetupCode,
} from './setup-code.js';
import { AUTH_AUDIT } from './shared.js';
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  demoSetupInput,
  everyRowAsText,
  rowsOf,
  seedFirstRun,
} from './test-support.js';
import { normaliseHumanCode } from './tokens.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** Every permission key the core declares: the Administrator role is made from them. */
const PERMISSION_KEYS = PERMISSION_LISTS.flatMap((list) =>
  list.map((entry) => entry.key),
);

type Done = Extract<
  Awaited<ReturnType<typeof completeFirstRunSetup>>,
  { ok: true }
>;

describe.each(testTargets)('first-run setup on $name', (target) => {
  describe('a setup with a password', () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let code: string;
    let done: Done;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      code = await seedFirstRun(database, T0);
      const result = await completeFirstRunSetup(
        database.db,
        demoSetupInput(code),
        at(MINUTE),
      );
      if (!result.ok) throw new Error('the setup was refused');
      done = result;
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;
    const auditOf = async (category: string) =>
      (await db().select().from(auditEvent)).filter(
        (event) => event.category === category,
      );

    it('answers the user, the organisation, and that the account needs no securing', () => {
      expect(done.mustSecureAccount).toBe(false);
      expect(done.user).toEqual({
        id: expect.any(String) as string,
        email: DEMO_ADMIN_EMAIL,
        displayName: 'Ada Demo',
        locale: 'en-GB',
        timezone: 'Europe/London',
        status: 'active',
      });
      expect(done.organisation).toEqual({
        id: expect.any(String) as string,
        slug: 'demo-pictures',
        name: 'Demo Pictures',
        country: 'GB',
        baseCurrency: 'GBP',
        locale: 'en-GB',
        timeZone: 'Europe/London',
      });
    });

    it('creates the organisation as its own tenant, made by the new user, through the write helper', async () => {
      const [row, ...rest] = await db().select().from(organisation);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        id: done.organisation.id,
        organisationId: done.organisation.id,
        ownerOrgId: done.organisation.id,
        slug: 'demo-pictures',
        defaultLocale: 'en-GB',
        defaultTimezone: 'Europe/London',
        baseCurrency: 'GBP',
        status: 'active',
        version: 1,
        createdBy: done.user.id,
        updatedBy: done.user.id,
      });
      const [event] = (await db().select().from(changeEvent)).filter(
        (found) => found.entityType === 'organisation',
      );
      expect(event).toMatchObject({
        entityId: done.organisation.id,
        organisationId: done.organisation.id,
        projectId: null,
        action: 'create',
        seq: 1,
        actorType: 'user',
        actorId: done.user.id,
      });
    });

    it('creates the user active, with the address as it is kept and the organisation’s locale and time zone', async () => {
      const [row, ...rest] = await db().select().from(user);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        id: done.user.id,
        email: DEMO_ADMIN_EMAIL,
        displayName: 'Ada Demo',
        status: 'active',
        locale: 'en-GB',
        timezone: 'Europe/London',
        createdBy: null,
      });
    });

    it('sets the password, and the user can sign in with it', async () => {
      const [credential] = await db().select().from(passwordCredential);
      expect(credential).toMatchObject({
        userId: done.user.id,
        mustChange: false,
      });
      const login = await verifyPasswordLogin(db(), {
        email: DEMO_ADMIN_EMAIL,
        password: DEMO_ADMIN_PASSWORD,
        now: at(2 * MINUTE),
      });
      expect(login).toMatchObject({ ok: true, totpRequired: false });
    });

    it('makes the user an active owner of the organisation, linked to the Administrator role', async () => {
      const members = await db().select().from(orgMembership);
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({
        organisationId: done.organisation.id,
        userId: done.user.id,
        orgRole: 'owner',
        status: 'active',
        createdBy: done.user.id,
      });
      const [administrator] = await db()
        .select()
        .from(role)
        .where(eq(role.key, ADMINISTRATOR_ROLE_KEY));
      const links = await db().select().from(orgMembershipRole);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        membershipId: members[0]!.id,
        roleId: administrator!.id,
      });
    });

    it('marks setup complete at the time given, and uses the setup code up', async () => {
      const [server] = await db().select().from(installation);
      expect(server!.setupCompletedAt).toEqual(at(MINUTE));
      expect(await isSetupComplete(db())).toBe(true);
      const [stored] = await db().select().from(setupCode);
      expect(stored!.usedAt).toEqual(at(MINUTE));
      expect(await consumeSetupCode(db(), code, at(2 * MINUTE))).toBe(false);
    });

    it('logs every change to the organisation in its own sequence, by the new user, and nothing of the user or the installation', async () => {
      const events = (await db().select().from(changeEvent)).sort(
        (a, b) => a.seq - b.seq,
      );
      // The organisation, the role, one grant for each permission, the
      // membership and its link.
      expect(events).toHaveLength(PERMISSION_KEYS.length + 4);
      expect(events.map((event) => event.seq)).toEqual(
        events.map((_event, index) => index + 1),
      );
      for (const event of events) {
        expect(event).toMatchObject({
          organisationId: done.organisation.id,
          projectId: null,
          action: 'create',
          actorType: 'user',
          actorId: done.user.id,
        });
      }
      expect(
        [...new Set(events.map((event) => event.entityType))].sort(),
      ).toEqual([
        'org_membership',
        'org_membership_role',
        'organisation',
        'role',
        'role_permission',
      ]);
      const [counter, ...others] = await db().select().from(changeSeq);
      expect(others).toEqual([]);
      expect(counter).toMatchObject({
        organisationId: done.organisation.id,
        projectId: null,
        lastSeq: events.length,
      });
    });

    it('writes an audit event for each part of the setup, with ids and no address', async () => {
      const [used] = await auditOf(AUTH_AUDIT.setupCodeUsed);
      expect(used).toMatchObject({
        actorType: 'system',
        targetType: 'setup_code',
      });

      const [created] = await auditOf(AUTH_AUDIT.userCreated);
      expect(created).toMatchObject({
        action: 'create',
        actorType: 'system',
        targetType: 'user',
        targetId: done.user.id,
        organisationId: null,
        details: { status: 'active' },
      });

      const [org] = await auditOf(AUTH_AUDIT.organisationCreated);
      expect(org).toMatchObject({
        action: 'create',
        actorType: 'user',
        actorId: done.user.id,
        targetType: 'organisation',
        targetId: done.organisation.id,
        organisationId: done.organisation.id,
      });

      const [administrator] = await db()
        .select()
        .from(role)
        .where(eq(role.key, ADMINISTRATOR_ROLE_KEY));
      const [roleEvent] = await auditOf(AUTH_AUDIT.roleCreated);
      expect(roleEvent).toMatchObject({
        action: 'create',
        actorId: done.user.id,
        targetType: 'role',
        targetId: administrator!.id,
        organisationId: done.organisation.id,
        details: {
          key: ADMINISTRATOR_ROLE_KEY,
          permissions: PERMISSION_KEYS.length,
        },
      });

      const [members] = await db().select().from(orgMembership);
      const [membership] = await auditOf(AUTH_AUDIT.membershipCreated);
      expect(membership).toMatchObject({
        action: 'create',
        actorId: done.user.id,
        targetType: 'org_membership',
        targetId: members!.id,
        organisationId: done.organisation.id,
        details: { orgRole: 'owner', roleKey: ADMINISTRATOR_ROLE_KEY },
      });

      const [server] = await db().select().from(installation);
      const [completed] = await auditOf(AUTH_AUDIT.setupCompleted);
      expect(completed).toMatchObject({
        action: 'complete',
        actorId: done.user.id,
        targetType: 'installation',
        targetId: server!.id,
        organisationId: done.organisation.id,
        details: {
          organisationId: done.organisation.id,
          userId: done.user.id,
        },
      });
      expect(completed!.occurredAt).toEqual(at(MINUTE));

      // One of each: the setup is one event for each part, not one for each grant.
      for (const category of [
        AUTH_AUDIT.userCreated,
        AUTH_AUDIT.organisationCreated,
        AUTH_AUDIT.roleCreated,
        AUTH_AUDIT.membershipCreated,
        AUTH_AUDIT.setupCompleted,
      ]) {
        expect(await auditOf(category), category).toHaveLength(1);
      }
    });

    it('keeps the code, the password and the address out of every audit event and change event, and the code and password out of every table', async () => {
      const secrets = [
        code,
        normaliseHumanCode(code)!,
        code.replaceAll('-', ''),
        DEMO_ADMIN_PASSWORD,
      ];
      const trail = JSON.stringify(await db().select().from(auditEvent));
      const changes = JSON.stringify(await db().select().from(changeEvent));
      for (const secret of secrets) {
        expect(trail, secret.slice(0, 4)).not.toContain(secret);
        expect(changes, secret.slice(0, 4)).not.toContain(secret);
      }
      // The address is stored in one place, the user, and written nowhere else.
      expect(trail).not.toContain(DEMO_ADMIN_EMAIL);
      expect(changes).not.toContain(DEMO_ADMIN_EMAIL);
      const everything = await everyRowAsText(database);
      for (const secret of secrets) {
        expect(everything, secret.slice(0, 4)).not.toContain(secret);
      }
    });

    it('makes no session: the caller does, in the same transaction', async () => {
      expect(await db().select().from(session)).toEqual([]);
    });

    it('refuses the same code a second time, creates nothing more, and audits the refusal without the code or the address', async () => {
      const other = 'someone.else@demopictures.example';
      const again = await completeFirstRunSetup(
        db(),
        demoSetupInput(code, { email: other }),
        at(3 * MINUTE),
      );
      expect(again).toEqual({ ok: false, reason: 'code-invalid' });
      expect(await db().select().from(organisation)).toHaveLength(1);
      expect(await db().select().from(user)).toHaveLength(1);
      expect(await db().select().from(orgMembership)).toHaveLength(1);
      const failed = await auditOf(AUTH_AUDIT.setupCheckFailed);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        action: 'check',
        actorType: 'system',
        actorId: null,
        targetType: null,
        targetId: null,
        details: { purpose: 'setup' },
      });
      const text = JSON.stringify(failed);
      expect(text).not.toContain(other);
      expect(text).not.toContain(code);
    });

    it('is closed for good: no new code is issued, and any code is refused', async () => {
      await expect(issueSetupCode(db(), at(4 * MINUTE))).rejects.toMatchObject({
        name: 'AuthStateError',
        reason: 'setup-complete',
      });
      expect(
        await completeFirstRunSetup(
          db(),
          demoSetupInput('AAAA-AAAA-AAAA-AAAA', {
            email: 'third.person@demopictures.example',
          }),
          at(5 * MINUTE),
        ),
      ).toEqual({ ok: false, reason: 'code-invalid' });
      expect(await db().select().from(organisation)).toHaveLength(1);
    });
  });

  describe('a setup without a password', () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let done: Done;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      const code = await seedFirstRun(database, T0);
      const input = demoSetupInput(code, { password: null });
      // No locale and no time zone either: the defaults are used.
      const { name, country, baseCurrency } = input.organisation;
      const result = await completeFirstRunSetup(
        database.db,
        { ...input, organisation: { name, country, baseCurrency } },
        at(MINUTE),
      );
      if (!result.ok) throw new Error('the setup was refused');
      done = result;
    });
    afterAll(async () => {
      await cleanup();
    });

    it('creates the account with no password, and says it must be secured', async () => {
      expect(done.mustSecureAccount).toBe(true);
      expect(await database.db.select().from(passwordCredential)).toEqual([]);
      const [row] = await database.db.select().from(user);
      expect(row).toMatchObject({ id: done.user.id, status: 'active' });
      // Nothing can be signed in with: there is no password to give.
      const login = await verifyPasswordLogin(database.db, {
        email: DEMO_ADMIN_EMAIL,
        password: DEMO_ADMIN_PASSWORD,
        now: at(2 * MINUTE),
      });
      expect(login).toEqual({ ok: false });
    });

    it('still creates the organisation, the role and the owner, and completes setup', async () => {
      expect(await isSetupComplete(database.db)).toBe(true);
      expect(await database.db.select().from(orgMembership)).toHaveLength(1);
      const roles = await database.db.select().from(role);
      expect(roles.map((found) => found.key)).toEqual([ADMINISTRATOR_ROLE_KEY]);
    });

    it('uses the defaults for a locale and a time zone it was not given, for the organisation and the user', async () => {
      expect(done.organisation.locale).toBe(SETUP_ORGANISATION_DEFAULTS.locale);
      expect(done.organisation.timeZone).toBe(
        SETUP_ORGANISATION_DEFAULTS.timeZone,
      );
      expect(done.user.locale).toBe(SETUP_ORGANISATION_DEFAULTS.locale);
      expect(done.user.timezone).toBe(SETUP_ORGANISATION_DEFAULTS.timeZone);
      const [row] = await database.db.select().from(organisation);
      expect(row).toMatchObject({
        defaultLocale: SETUP_ORGANISATION_DEFAULTS.locale,
        defaultTimezone: SETUP_ORGANISATION_DEFAULTS.timeZone,
      });
    });

    it('writes no password event', async () => {
      const events = await database.db.select().from(auditEvent);
      expect(
        events.filter((event) => event.category === AUTH_AUDIT.passwordSet),
      ).toEqual([]);
    });
  });

  describe('when the setup is refused', () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let code: string;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      code = await seedFirstRun(database, T0);
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;

    /** How many rows each table the setup writes has, and whether the installation is complete. */
    async function state() {
      const [counts] = await rowsOf(
        database,
        sql`select
              (select count(*)::int from "user") as users,
              (select count(*)::int from organisation) as organisations,
              (select count(*)::int from role) as roles,
              (select count(*)::int from role_permission) as grants,
              (select count(*)::int from org_membership) as members,
              (select count(*)::int from org_membership_role) as links,
              (select count(*)::int from password_credential) as passwords,
              (select count(*)::int from change_event) as changes,
              (select count(*)::int from change_seq) as counters,
              (select count(*)::int from session) as sessions,
              (select count(*)::int from installation
                 where setup_completed_at is not null) as completed`,
      );
      return counts;
    }

    /** The `state()` of a database no setup has touched. */
    const UNTOUCHED = {
      users: 0,
      organisations: 0,
      roles: 0,
      grants: 0,
      members: 0,
      links: 0,
      passwords: 0,
      changes: 0,
      counters: 0,
      sessions: 0,
      completed: 0,
    };

    const authEvents = async (category: string) =>
      (await db().select().from(auditEvent)).filter(
        (event) => event.category === category,
      );
    const trailLength = async () =>
      (await db().select().from(auditEvent)).length;

    /** The live code can still be used: nothing refused so far has spent it. */
    const stillLive = async () => {
      const failures = (await authEvents(AUTH_AUDIT.setupCheckFailed)).length;
      const live = await checkSetupCode(db(), code, at(MINUTE));
      // Asking whether it is live is not a failure, so it left no event.
      expect((await authEvents(AUTH_AUDIT.setupCheckFailed)).length).toBe(
        failures,
      );
      return live;
    };

    it('starts with nothing made and a live code', async () => {
      expect(await state()).toEqual(UNTOUCHED);
      expect(await stillLive()).toBe(true);
    });

    describe('a code that does not work', () => {
      const refusal = { ok: false, reason: 'code-invalid' } as const;

      /** One refusal: the same answer, nothing made, an audit event of the check. */
      async function expectRefused(typed: string, now: Date) {
        const before = (await authEvents(AUTH_AUDIT.setupCheckFailed)).length;
        const result = await completeFirstRunSetup(
          db(),
          demoSetupInput(typed),
          now,
        );
        expect(result).toEqual(refusal);
        expect(await state()).toEqual(UNTOUCHED);
        const events = await authEvents(AUTH_AUDIT.setupCheckFailed);
        expect(events).toHaveLength(before + 1);
        expect(events.at(-1)).toMatchObject({
          actorType: 'system',
          details: { purpose: 'setup' },
        });
        if (typed !== '') expect(JSON.stringify(events)).not.toContain(typed);
      }

      it('an unknown one', async () => {
        await expectRefused('AAAA-AAAA-AAAA-AAAA', at(MINUTE));
        expect(await stillLive()).toBe(true);
      });

      it('one that is not shaped like a code', async () => {
        await expectRefused('this is not a code', at(MINUTE));
        await expectRefused('', at(MINUTE));
      });

      it('one that has expired', async () => {
        await expectRefused(code, at(25 * HOUR));
        // The code is the live one still: only the time was wrong.
        expect(await stillLive()).toBe(true);
      });

      it('one a newer code replaced', async () => {
        const old = code;
        code = await issueSetupCode(db(), at(2 * MINUTE));
        await expectRefused(old, at(3 * MINUTE));
        expect(await stillLive()).toBe(true);
      });

      it('one that was used', async () => {
        const spent = code;
        expect(await consumeSetupCode(db(), spent, at(4 * MINUTE))).toBe(true);
        await expectRefused(spent, at(5 * MINUTE));
        // Setup is not complete, so a new code may be issued.
        code = await issueSetupCode(db(), at(6 * MINUTE));
        expect(await stillLive()).toBe(true);
      });

      it('with one answer for every cause', async () => {
        const answers = new Set<string>();
        for (const typed of ['AAAA-AAAA-AAAA-AAAA', 'nonsense']) {
          const result = await completeFirstRunSetup(
            db(),
            demoSetupInput(typed),
            at(7 * MINUTE),
          );
          answers.add(JSON.stringify(result));
        }
        expect(answers).toEqual(new Set([JSON.stringify(refusal)]));
      });
    });

    describe('a password the policy refuses', () => {
      it.each([
        ['too-short', 'short'],
        ['too-common', 'correcthorsebatterystaple'],
        ['too-predictable', 'abcdefghijklmnop'],
        ['contains-email', 'riverside-demopictures-fan-club'],
        ['contains-product-name', 'we love osfpm so very much'],
      ])(
        '%s: gives the reason, rolls everything back and keeps the code',
        async (reason, password) => {
          const before = await trailLength();
          const result = await completeFirstRunSetup(
            db(),
            demoSetupInput(code, { password }),
            at(8 * MINUTE),
          );
          expect(result).toEqual({
            ok: false,
            reason: 'password-refused',
            refusal: reason,
          });
          // The user was made, and the code spent, before the policy said no, and
          // both are undone: the person gives a better password with the same code.
          expect(await state()).toEqual(UNTOUCHED);
          expect(await stillLive()).toBe(true);
          // A refused password is not a guess, so it is not an event, and the
          // events of the steps before it went with them.
          expect(await trailLength()).toBe(before);
          if (password.length >= 15) {
            expect(await everyRowAsText(database)).not.toContain(password);
          }
        },
      );
    });

    describe('input that is not acceptable', () => {
      const changes: [
        string,
        (input: FirstRunSetupInput) => FirstRunSetupInput,
      ][] = [
        [
          'organisation.name',
          (i) => ({ ...i, organisation: { ...i.organisation, name: '   ' } }),
        ],
        [
          'organisation.country',
          (i) => ({ ...i, organisation: { ...i.organisation, country: 'gb' } }),
        ],
        [
          'organisation.country',
          (i) => ({
            ...i,
            organisation: { ...i.organisation, country: 'GBR' },
          }),
        ],
        [
          'organisation.baseCurrency',
          (i) => ({
            ...i,
            organisation: { ...i.organisation, baseCurrency: 'gbp' },
          }),
        ],
        [
          'organisation.baseCurrency',
          (i) => ({
            ...i,
            organisation: { ...i.organisation, baseCurrency: 'GB' },
          }),
        ],
        [
          'organisation.locale',
          (i) => ({
            ...i,
            organisation: { ...i.organisation, locale: 'en_GB' },
          }),
        ],
        [
          'organisation.timeZone',
          (i) => ({
            ...i,
            organisation: { ...i.organisation, timeZone: 'Mars/Olympus' },
          }),
        ],
        [
          'admin.email',
          (i) => ({ ...i, admin: { ...i.admin, email: 'nobody' } }),
        ],
        [
          'admin.displayName',
          (i) => ({ ...i, admin: { ...i.admin, displayName: '' } }),
        ],
      ];

      it.each(changes)(
        'refuses %s, before anything is written and before the code is looked at',
        async (field, change) => {
          const before = await trailLength();
          await expect(
            completeFirstRunSetup(
              db(),
              change(demoSetupInput(code)),
              at(9 * MINUTE),
            ),
          ).rejects.toMatchObject({ name: 'AuthInputError', field });
          expect(await state()).toEqual(UNTOUCHED);
          expect(await stillLive()).toBe(true);
          expect(await trailLength()).toBe(before);
        },
      );
    });

    describe('a step that fails after the organisation exists', () => {
      /** Makes every `operation` on `table` fail with a database error, until the returned function is called. */
      async function refuse(table: string, operation: 'insert' | 'update') {
        await db().execute(
          sql.raw(`create function osfpm_test_refuse() returns trigger
                   language plpgsql as $$
                   begin
                     raise exception 'refused' using errcode = 'P0001';
                   end $$`),
        );
        await db().execute(
          sql.raw(`create trigger osfpm_test_refuse
                   before ${operation} on ${table}
                   for each row execute function osfpm_test_refuse()`),
        );
        return async () => {
          await db().execute(
            sql.raw(`drop trigger osfpm_test_refuse on ${table}`),
          );
          await db().execute(sql.raw('drop function osfpm_test_refuse()'));
        };
      }

      it.each([
        ['the membership', 'org_membership', 'insert'],
        ['the Administrator role', 'role', 'insert'],
        ['completing setup', 'installation', 'update'],
      ] as const)(
        'failing to write %s leaves nothing: no user, no organisation, no role, no grant, no event, and the code still works',
        async (_what, table, operation) => {
          const before = await trailLength();
          const restore = await refuse(table, operation);
          let error: unknown;
          try {
            await completeFirstRunSetup(
              db(),
              demoSetupInput(code),
              at(10 * MINUTE),
            );
          } catch (caught) {
            error = caught;
          } finally {
            await restore();
          }
          // The database's own refusal, with its SQLSTATE and nothing it was given.
          expect(error).toMatchObject({
            name: 'RecordWriteError',
            code: 'P0001',
          });
          const message = (error as Error).message;
          for (const value of [code, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD]) {
            expect(message).not.toContain(value);
          }
          // By then the user, the organisation and the earlier steps had been
          // written: every one of them, and every event, is gone.
          expect(await state()).toEqual(UNTOUCHED);
          expect(await trailLength()).toBe(before);
          expect(await stillLive()).toBe(true);
        },
      );

      it('lets the same code complete the setup once the fault is gone', async () => {
        const result = await completeFirstRunSetup(
          db(),
          demoSetupInput(code),
          at(11 * MINUTE),
        );
        expect(result.ok).toBe(true);
        expect(await state()).toMatchObject({
          users: 1,
          organisations: 1,
          roles: 1,
          members: 1,
          links: 1,
          completed: 1,
        });
      });
    });
  });

  describe('before the installation row exists', () => {
    it('refuses, and writes nothing', async () => {
      const { database, cleanup } = await createMigratedDatabase(target);
      try {
        await expect(
          completeFirstRunSetup(
            database.db,
            demoSetupInput('AAAA-AAAA-AAAA-AAAA'),
            T0,
          ),
        ).rejects.toMatchObject({
          name: 'AuthStateError',
          reason: 'installation-missing',
        });
        expect(await database.db.select().from(organisation)).toEqual([]);
      } finally {
        await cleanup();
      }
    });
  });
});

describe('slugFromName', () => {
  it('makes a lower case, hyphenated, plain form of the name', () => {
    expect(slugFromName('Demo Pictures')).toBe('demo-pictures');
    expect(slugFromName('  The Last Withdrawal & Co.  ')).toBe(
      'the-last-withdrawal-co',
    );
    expect(slugFromName('Harbour---Light__Films')).toBe('harbour-light-films');
  });

  it('drops accents, whether the letter is composed or written with a combining mark', () => {
    const e = String.fromCodePoint(0xe9);
    const composed = `Caf${e} Soci${e}t${e}`;
    const mark = String.fromCodePoint(0x301);
    const combining = `Cafe${mark} Societe${mark}`;
    expect(slugFromName(composed)).toBe('cafe-societe');
    expect(slugFromName(combining)).toBe('cafe-societe');
  });

  it('falls back to a fixed word when nothing of the name is left', () => {
    expect(slugFromName('')).toBe('organisation');
    expect(slugFromName('---')).toBe('organisation');
    // Letters this form has no plain spelling for are dropped, not guessed.
    expect(slugFromName(String.fromCodePoint(0x65e5, 0x672c))).toBe(
      'organisation',
    );
  });

  it('is at most 63 characters and never ends in a hyphen', () => {
    const slug = slugFromName(`${'a'.repeat(62)} ${'b'.repeat(20)}`);
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug).toBe('a'.repeat(62));
  });
});

describe('normaliseLocale and normaliseTimeZone', () => {
  it.each([
    ['en-gb', 'en-GB'],
    ['EN', 'en'],
    ['fr-CA', 'fr-CA'],
  ])('writes the locale %s as %s', (typed, canonical) => {
    expect(normaliseLocale(typed)).toBe(canonical);
  });

  it.each(['', 'en_GB', 'not a locale', 'e', '123'])(
    'refuses %j as a locale',
    (typed) => {
      expect(normaliseLocale(typed)).toBeNull();
    },
  );

  it.each([
    ['Europe/London', 'Europe/London'],
    // The case of a zone the platform lists is corrected.
    ['europe/london', 'Europe/London'],
    ['UTC', 'UTC'],
    ['utc', 'UTC'],
    // The name that was typed is kept, although the platform's own spelling of
    // these is an older alias: it must not change what the administrator chose.
    ['America/Argentina/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
    ['Europe/Kyiv', 'Europe/Kyiv'],
    ['Asia/Kolkata', 'Asia/Kolkata'],
  ])('writes the time zone %s as %s', (typed, stored) => {
    expect(normaliseTimeZone(typed)).toBe(stored);
  });

  it.each(['', 'Mars/Olympus', '+01:00', '-05:00', 'London', 'Europe London'])(
    'refuses %j as a time zone',
    (typed) => {
      expect(normaliseTimeZone(typed)).toBeNull();
    },
  );

  it('has defaults that are themselves valid', () => {
    expect(normaliseLocale(SETUP_ORGANISATION_DEFAULTS.locale)).toBe(
      SETUP_ORGANISATION_DEFAULTS.locale,
    );
    expect(normaliseTimeZone(SETUP_ORGANISATION_DEFAULTS.timeZone)).toBe(
      SETUP_ORGANISATION_DEFAULTS.timeZone,
    );
  });
});
