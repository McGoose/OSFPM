import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '@osfpm/core/src/access/test-fixtures.js';
import { createAccessReset } from '@osfpm/core/src/auth/access-reset.js';
import { generateRecoveryCodes } from '@osfpm/core/src/auth/recovery.js';
import { createSession } from '@osfpm/core/src/auth/sessions.js';
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import {
  emailOf,
  everyRowAsText,
  markUserDeleted,
  seedApiToken,
  seedInstallation,
  seedMembership,
  seedPasskey,
  seedPassword,
  seedResetScene,
  seedTotp,
  setMemberRolesEnded,
  setMembershipStatus,
  setUserStatus,
  type ResetScene,
} from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import {
  accessReset,
  apiToken,
  auditEvent,
  passkeyCredential,
  passwordCredential,
  recoveryCode,
  session,
  totpCredential,
  type OrgRole,
} from '@osfpm/core/src/db/schema/index.js';
import {
  createMigratedDatabase,
  testTargets,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import {
  createTestApp,
  TEST_KEYS_DIR,
  TEST_PUBLIC_ORIGIN,
  TEST_SERVER_KEYS,
} from '../test-support.js';
import { adminEnvironment, runCommand } from './test-support.js';

/**
 * The `emergency-access` command (P-09a2, decision D-81): the only way back in for
 * an organisation whose sole administrator has lost every way to sign in. It makes
 * a reset link as the system, for an owner or a holder of the Administrator role,
 * and prints it once, on standard error. The rules for who may be given one are in
 * the core (`access-reset-system.test.ts`, `emergency-access.test.ts`); these tests
 * run the command line over a real database and use the link through the real route.
 */

const NOW = new Date('2026-03-02T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/** Invented passwords: none is real, and none holds a word of the fixture addresses. */
const OLD_PASSWORD = 'meadow-lantern-slow-river';

/** The link as the command prints it: the public origin, `/reset#` and the 43 characters of the token. */
const LINK =
  /^Link: (https:\/\/osfpm\.example\.test)\/reset#([A-Za-z0-9_-]{43})$/;

describe.each(testTargets)(
  'the emergency-access command on $name',
  (target) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let scene: ResetScene;
    let addresses = 0;

    /** Every token the command printed, which must stay out of everything but standard error. */
    const tokens: string[] = [];
    /** Every error body a route answered, which must not hold one either. */
    const errorBodies: string[] = [];
    /** What the command printed on standard output and standard error, in every run. */
    const printed: { stdout: string[]; stderr: string[] } = {
      stdout: [],
      stderr: [],
    };

    beforeAll(async () => {
      ctx = await createTestApp(target, { logLevel: 'trace' });
      await migrate(ctx.database);
      scene = await seedResetScene(ctx.database, NOW);
    });
    afterAll(async () => {
      await ctx.close();
    });

    const db = () => ctx.database.db;
    const freshAddress = () =>
      `10.31.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

    /** The settings of every run: the server's own variables, with the test app's origin. */
    const env = () => adminEnvironment(target.name, TEST_KEYS_DIR);

    /** Runs the command line over the test database, and keeps what it printed for the scans. */
    async function run(argv: string[], now?: Date) {
      const result = await runCommand(argv, {
        env: env(),
        database: ctx.database,
        ...(now === undefined ? {} : { now: () => now }),
      });
      printed.stdout.push(result.stdout);
      printed.stderr.push(result.stderr);
      return result;
    }

    /** The token in what the command printed on standard error, which is kept for the scans. */
    function tokenOf(stderr: string): string {
      const found = stderr
        .split('\n')
        .map((line) => LINK.exec(line))
        .find((match) => match !== null);
      if (found === undefined) throw new Error('No link was printed');
      tokens.push(found[2]!);
      return found[2]!;
    }

    /** A member of the organisation: `tier`, with the roles given. */
    async function member(
      tier: OrgRole,
      roleIds: readonly string[],
      options: { status?: 'active' | 'invited' | 'removed' } = {},
    ) {
      const userId = await seedUser(ctx.database);
      await seedMembership(
        ctx.database,
        scene.organisationId,
        userId,
        tier,
        roleIds,
        options,
      );
      return userId;
    }
    /** An administrator who is not an owner: tier `admin`, with the Administrator role. */
    const administrator = () => member('admin', [scene.roles.administrator]);

    /** One request to the real route, from the site itself, from an address of its own. */
    async function useRoute(token: unknown) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/access-reset`,
        headers: { origin: TEST_PUBLIC_ORIGIN },
        remoteAddress: freshAddress(),
        payload: { token } as Record<string, unknown>,
      });
      if (response.statusCode >= 400) errorBodies.push(response.body);
      return response;
    }

    const linksOf = async (userId: string) =>
      (await db().select().from(accessReset)).filter(
        (found) => found.userId === userId,
      );
    const audits = async (category: string) =>
      (await db().select().from(auditEvent))
        .filter((event) => event.category === category)
        .sort((a, b) => a.id.localeCompare(b.id));

    describe('the link it makes', () => {
      it('prints it on standard error and says only that on standard output: for which user id, and when it ends', async () => {
        const result = await run(
          ['emergency-access', '--user', scene.ownerId],
          NOW,
        );

        expect(result.code).toBe(0);
        const [link] = (await linksOf(scene.ownerId)).filter(
          (found) => found.revokedAt === null && found.usedAt === null,
        );
        expect(link).toBeDefined();
        // An hour, unless the operator says otherwise.
        expect(link!.expiresAt).toEqual(new Date(NOW.getTime() + HOUR));
        expect(result.stdout).toBe(
          `Printed an emergency access link for user ${scene.ownerId} on standard error. It expires at ${link!.expiresAt.toISOString()}.\n`,
        );
        const lines = result.stderr.split('\n');
        expect(lines[0]).toBe('=== OSFPM emergency access ===');
        expect(lines[1]).toMatch(LINK);
        expect(lines.at(-1)).toBe('');
        const token = tokenOf(result.stderr);
        // The row holds the hash of what was printed, and not what was printed.
        expect(link).toMatchObject({
          createdBy: null,
          issuedBySystem: true,
          removePasskeys: false,
        });
        expect(link!.tokenHash).not.toBe(token);
      });

      it('is for an administrator who is not an owner too, found by the address as typed, for the hours asked, with the passkeys to go', async () => {
        const email = await emailOf(ctx.database, scene.adminId);

        const result = await run(
          [
            'emergency-access',
            '--email',
            `  ${email.toUpperCase()}  `,
            '--hours',
            '5',
            '--remove-passkeys',
          ],
          NOW,
        );

        expect(result.code).toBe(0);
        const [link] = (await linksOf(scene.adminId)).filter(
          (found) => found.revokedAt === null && found.usedAt === null,
        );
        expect(link).toMatchObject({
          issuedBySystem: true,
          createdBy: null,
          removePasskeys: true,
          expiresAt: new Date(NOW.getTime() + 5 * HOUR),
        });
        // Neither the address nor the id is on standard error: only the link is.
        expect(result.stderr).not.toContain(email);
        expect(result.stdout).not.toContain(email);
        tokenOf(result.stderr);
      });

      it('audits one event for it, from the system, and writes no admin.command-run', async () => {
        const person = await administrator();
        const runs = (await audits(AUTH_AUDIT.adminCommandRun)).length;
        const created = (await audits(AUTH_AUDIT.accessResetCreated)).length;

        const result = await run(['emergency-access', '--user', person], NOW);
        tokenOf(result.stderr);

        expect(await audits(AUTH_AUDIT.adminCommandRun)).toHaveLength(runs);
        const events = (await audits(AUTH_AUDIT.accessResetCreated)).slice(
          created,
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          action: 'create',
          actorType: 'system',
          actorId: null,
          organisationId: scene.organisationId,
          details: { userId: person, issuedBySystem: true },
        });
      });

      it('ends an earlier link of the person, one an owner made too, as the system', async () => {
        const person = await administrator();
        // Both on the real clock, because the links are used through the real route.
        const earlier = await createAccessReset(
          db(),
          { userId: scene.ownerId },
          scene.organisationId,
          person,
          {},
          new Date(),
        );

        const result = await run(['emergency-access', '--user', person]);
        const token = tokenOf(result.stderr);

        const [old] = (await linksOf(person)).filter(
          (found) => found.id === earlier.reset.id,
        );
        expect(old).toMatchObject({ revokedBy: null, revokedBySystem: true });
        expect(old!.revokedAt).not.toBeNull();
        // The earlier token no longer works, and the new one does.
        expect((await useRoute(earlier.token)).statusCode).toBe(401);
        expect((await useRoute(token)).statusCode).toBe(200);
      });

      it('makes a new link each time it is run, and each ends the one before', async () => {
        const person = await administrator();
        // On the real clock, because the links are used through the real route.
        const first = tokenOf(
          (await run(['emergency-access', '--user', person])).stderr,
        );
        const second = tokenOf(
          (await run(['emergency-access', '--user', person])).stderr,
        );

        expect(first).not.toBe(second);
        const live = (await linksOf(person)).filter(
          (found) => found.revokedAt === null && found.usedAt === null,
        );
        expect(live).toHaveLength(1);
        expect((await useRoute(first)).statusCode).toBe(401);
        expect((await useRoute(second)).statusCode).toBe(200);
      });
    });

    describe('using it', () => {
      /** An administrator who is locked out: every way in, and a session and a token that work. */
      async function lockedOut() {
        const userId = await administrator();
        await seedPassword(ctx.database, userId, OLD_PASSWORD, { now: NOW });
        await seedTotp(ctx.database, userId, {
          now: NOW,
          dataKeys: TEST_SERVER_KEYS.dataKeys,
        });
        await generateRecoveryCodes(db(), userId, { now: NOW });
        const passkeys = [
          await seedPasskey(ctx.database, userId),
          await seedPasskey(ctx.database, userId),
        ];
        const old = await createSession(db(), {
          userId,
          method: 'password',
          now: new Date(),
        });
        const token = await seedApiToken(
          ctx.database,
          scene.organisationId,
          userId,
        );
        return {
          userId,
          passkeys,
          oldSession: old.session.id,
          token: token.id,
        };
      }
      const stateOf = async (userId: string) => ({
        sessions: (await db().select().from(session)).filter(
          (found) => found.userId === userId,
        ),
        passwords: (await db().select().from(passwordCredential)).filter(
          (found) => found.userId === userId,
        ),
        totp: (await db().select().from(totpCredential)).filter(
          (found) => found.userId === userId,
        ),
        codes: (await db().select().from(recoveryCode)).filter(
          (found) => found.userId === userId,
        ),
        passkeys: (await db().select().from(passkeyCredential)).filter(
          (found) => found.userId === userId,
        ),
        tokens: (await db().select().from(apiToken)).filter(
          (found) => found.userId === userId,
        ),
      });

      it('signs the person in with a recovery session, and clears exactly what a reset link clears', async () => {
        const locked = await lockedOut();
        const result = await run(['emergency-access', '--user', locked.userId]);
        const token = tokenOf(result.stderr);

        const response = await useRoute(token);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          user: { id: locked.userId },
          mustSecureAccount: true,
        });
        expect(response.headers['set-cookie']).toBeDefined();
        const after = await stateOf(locked.userId);
        // The new session may only secure the account.
        const made = after.sessions.find(
          (found) => found.id !== locked.oldSession && found.revokedAt === null,
        );
        expect(made).toMatchObject({ method: 'reset', scope: 'recovery' });
        // Every other session ended, with the reset's reason.
        expect(
          after.sessions.find((found) => found.id === locked.oldSession),
        ).toMatchObject({ revokedReason: 'access-reset' });
        expect(after.passwords).toEqual([]);
        expect(after.totp).toEqual([]);
        expect(after.codes).toEqual([]);
        // The passkeys stay unless the operator asked.
        expect(
          after.passkeys.filter((found) => found.revokedAt === null),
        ).toHaveLength(2);
        expect(after.tokens[0]).toMatchObject({
          revokedBy: null,
          revokeReason: 'access-reset',
        });
        const [used] = (await audits(AUTH_AUDIT.accessResetUsed)).filter(
          (event) => event.actorId === locked.userId,
        );
        expect(used!.details).toMatchObject({
          sessionsRevoked: 1,
          tokensRevoked: 1,
          passwordCleared: true,
          totpRemoved: true,
          recoveryCodesRemoved: 10,
          passkeysRemoved: 0,
        });
      });

      it('also revokes the passkeys when the operator said --remove-passkeys', async () => {
        const locked = await lockedOut();
        const token = tokenOf(
          (
            await run([
              'emergency-access',
              '--user',
              locked.userId,
              '--remove-passkeys',
            ])
          ).stderr,
        );

        expect((await useRoute(token)).statusCode).toBe(200);

        const { passkeys } = await stateOf(locked.userId);
        expect(passkeys.filter((found) => found.revokedAt === null)).toEqual(
          [],
        );
      });

      it('is refused, with the one 401 every bad link gets and the reason in the audit trail, for a person who stopped being an administrator after the link was made', async () => {
        const locked = await lockedOut();
        const token = tokenOf(
          (await run(['emergency-access', '--user', locked.userId])).stderr,
        );
        await setMemberRolesEnded(
          ctx.database,
          scene.organisationId,
          locked.userId,
          true,
        );
        const before = JSON.stringify(await stateOf(locked.userId));

        const refused = await useRoute(token);
        const unknown = await useRoute('nobody-made-this');

        expect(refused.statusCode).toBe(401);
        // The same body as for a token nobody made: it says nothing about why.
        const sameness = (body: string) =>
          JSON.stringify({
            ...(JSON.parse(body) as Record<string, unknown>),
            requestId: undefined,
            instance: undefined,
          });
        expect(sameness(refused.body)).toBe(sameness(unknown.body));
        expect(JSON.stringify(await stateOf(locked.userId))).toBe(before);
        const events = await audits(AUTH_AUDIT.accessResetUseRefused);
        expect(
          events.filter(
            (event) =>
              (event.details as { reason?: string } | null)?.reason ===
              'not-an-administrator',
          ),
        ).toHaveLength(1);
        // Put right, the same link works.
        await setMemberRolesEnded(
          ctx.database,
          scene.organisationId,
          locked.userId,
          false,
        );
        expect((await useRoute(token)).statusCode).toBe(200);
      });
    });

    describe('who it refuses', () => {
      /** Runs the command, which must refuse, and checks everything a refusal must leave. */
      async function refused(
        argv: string[],
        message: string,
        reason: string,
        typed: string[] = [],
      ) {
        const links = (await db().select().from(accessReset)).length;
        const runs = (await audits(AUTH_AUDIT.adminCommandRun)).length;

        const result = await run(argv, NOW);

        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe(`${message}\n`);
        for (const value of typed) {
          expect(result.stderr).not.toContain(value);
        }
        // No link, and one event that says what and why, naming no one.
        expect(await db().select().from(accessReset)).toHaveLength(links);
        const written = (await audits(AUTH_AUDIT.adminCommandRun)).slice(runs);
        expect(written).toHaveLength(1);
        expect(written[0]).toMatchObject({
          actorType: 'system',
          actorId: null,
          details: {
            command: 'emergency-access',
            outcome: 'refused',
            reason,
          },
        });
        for (const value of typed) {
          expect(JSON.stringify(written)).not.toContain(value);
        }
      }

      const NOT_AN_ADMINISTRATOR =
        'Only an owner of the organisation, or a member who holds its Administrator role, can be given an emergency access link. Anyone else is helped by their own administrator, with a reset link.';

      it('a plain member, whom their own administrator helps with a reset link', async () => {
        const email = await emailOf(ctx.database, scene.plainId);
        await refused(
          ['emergency-access', '--user', scene.plainId],
          NOT_AN_ADMINISTRATOR,
          'not-an-administrator',
          [scene.plainId],
        );
        await refused(
          ['emergency-access', '--email', email],
          NOT_AN_ADMINISTRATOR,
          'not-an-administrator',
          [email],
        );
      });

      it('a member who may make reset links but is not an administrator', async () => {
        await refused(
          ['emergency-access', '--user', scene.resetterId],
          NOT_AN_ADMINISTRATOR,
          'not-an-administrator',
        );
      });

      it('an account that is disabled or only invited', async () => {
        for (const status of ['disabled', 'invited'] as const) {
          const person = await administrator();
          await setUserStatus(ctx.database, person, status);
          await refused(
            ['emergency-access', '--user', person],
            'That account is not active: it is disabled, or only invited.',
            'user-not-active',
            [person],
          );
        }
      });

      it('a membership that was removed, or is only an invitation', async () => {
        for (const status of ['removed', 'invited'] as const) {
          const person = await administrator();
          await setMembershipStatus(
            ctx.database,
            scene.organisationId,
            person,
            status,
          );
          await refused(
            ['emergency-access', '--user', person],
            'That person’s membership of the organisation is not active: it was removed, or is still only an invitation.',
            'membership-not-active',
          );
        }
      });

      it('an address no one has, and an account that was deleted, in the same words, without repeating the address', async () => {
        const gone = await administrator();
        const goneEmail = await emailOf(ctx.database, gone);
        await markUserDeleted(ctx.database, gone, NOW);
        const nobody = 'nobody.here@example.test';
        for (const typed of [nobody, goneEmail]) {
          await refused(
            ['emergency-access', '--email', typed],
            'No account matches.',
            'unknown-user',
            [typed],
          );
        }
        await refused(
          [
            'emergency-access',
            '--user',
            '01a21347-bb08-7167-bc54-000000000009',
          ],
          'No account matches.',
          'unknown-user',
        );
      });

      it('a person who belongs to more than one organisation, until the command is told which', async () => {
        const person = await administrator();
        await seedMembership(
          ctx.database,
          scene.otherOrganisationId,
          person,
          'owner',
          [],
        );
        await refused(
          ['emergency-access', '--user', person],
          'That person belongs to more than one organisation. Name the one with --organisation <id>.',
          'organisation-required',
        );

        const named = await run(
          [
            'emergency-access',
            '--user',
            person,
            '--organisation',
            scene.otherOrganisationId,
          ],
          NOW,
        );
        expect(named.code).toBe(0);
        tokenOf(named.stderr);
        const [link] = (await linksOf(person)).filter(
          (found) => found.revokedAt === null && found.usedAt === null,
        );
        expect(link!.organisationId).toBe(scene.otherOrganisationId);
      });

      it('an organisation the person is not a member of, or that does not exist, in the same words', async () => {
        for (const organisationId of [
          scene.otherOrganisationId,
          '01a21347-bb08-7167-bc54-000000000009',
        ]) {
          await refused(
            [
              'emergency-access',
              '--user',
              scene.ownerId,
              '--organisation',
              organisationId,
            ],
            'That person is not a member of the organisation.',
            'not-a-member',
            [organisationId],
          );
        }
      });

      it('a database where first-run setup is not complete', async () => {
        const fresh = await createMigratedDatabase(target);
        try {
          await seedInstallation(fresh.database);
          const person = await seedUser(fresh.database);

          const result = await runCommand(
            ['emergency-access', '--user', person],
            { env: env(), database: fresh.database, now: () => NOW },
          );

          expect(result.code).toBe(1);
          expect(result.stdout).toBe('');
          expect(result.stderr).toBe(
            'First-run setup is not complete, so there is no administrator to help yet. Finish setup with the setup code the server prints when it starts.\n',
          );
          const [event] = await fresh.database.db.select().from(auditEvent);
          expect(event).toMatchObject({
            category: AUTH_AUDIT.adminCommandRun,
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

      it('a database that has no installation at all', async () => {
        const fresh = await createMigratedDatabase(target);
        try {
          const result = await runCommand(
            ['emergency-access', '--email', 'someone@example.test'],
            { env: env(), database: fresh.database, now: () => NOW },
          );

          expect(result.code).toBe(1);
          expect(result.stdout).toBe('');
          expect(result.stderr).toBe(
            'There is no installation on this database yet: the server has never started on it, so there is nobody to give access to.\n',
          );
          expect(result.stderr).not.toContain('someone@example.test');
        } finally {
          await fresh.cleanup();
        }
      });
    });

    describe('what it keeps secret', () => {
      it('puts a link on standard error and nowhere else: not standard output, the logs, the audit trail, any row or an error body', async () => {
        const person = await administrator();
        // On the real clock, because the link is used through the real route.
        const result = await run(['emergency-access', '--user', person]);
        const token = tokenOf(result.stderr);
        // Use it, and fail to use it, so the routes have logged and answered both ways.
        expect((await useRoute(token)).statusCode).toBe(200);
        expect((await useRoute(token)).statusCode).toBe(401);

        expect(tokens).toContain(token);
        for (const secret of tokens) {
          expect(printed.stdout.join('\n'), 'standard output').not.toContain(
            secret,
          );
          expect(ctx.lines.join('\n'), 'the logs').not.toContain(secret);
          expect(errorBodies.join('\n'), 'the error bodies').not.toContain(
            secret,
          );
          expect(
            JSON.stringify(await db().select().from(auditEvent)),
            'the audit trail',
          ).not.toContain(secret);
          expect(await everyRowAsText(ctx.database), 'the rows').not.toContain(
            secret,
          );
        }
        // Standard error holds the link, once for each run, and the refusals’ plain sentences.
        const links = printed.stderr
          .join('\n')
          .split('\n')
          .filter((line) => LINK.test(line));
        expect(links.length).toBeGreaterThan(0);
      });

      it('never prints a database address or an address of a person', () => {
        const text = [...printed.stdout, ...printed.stderr].join('\n');
        expect(text).not.toContain('not-a-real-password-4711');
        expect(text).not.toContain('db.example.test');
        // No address of any person, whatever its domain: none has an @ in it.
        expect(text).not.toContain('@');
      });
    });
  },
);
