import { like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSION_LISTS } from '../access/permission-lists.js';
import { syncPermissions } from '../access/permission-sync.js';
import { tenantTableNames } from '../db/columns.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { auditEvent, SECURITY_TABLES } from '../db/schema/index.js';
import { getTableName } from 'drizzle-orm';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { ensureInstallation } from './ensure-installation.js';
import { completeFirstRunSetup } from './first-run-setup.js';
import {
  consumeLoginChallenge,
  createLoginChallenge,
} from './login-challenge.js';
import {
  finishPasskeyLogin,
  finishPasskeyRegistration,
  relyingPartyFor,
  renamePasskey,
  revokePasskey,
  startPasskeyLogin,
  startPasskeyRegistration,
} from './passkeys.js';
import { hashPassword } from './password.js';
import { setPassword, verifyPasswordLogin } from './password-service.js';
import { consumeRecoveryCode, generateRecoveryCodes } from './recovery.js';
import {
  createSession,
  disableUser,
  enableUser,
  revokeSession,
  revokeUserSessions,
  validateSession,
} from './sessions.js';
import {
  checkSetupCode,
  consumeSetupCode,
  issueSetupCode,
} from './setup-code.js';
import { AUTH_AUDIT } from './shared.js';
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  demoSetupInput,
  emailOf,
  everyRowAsText,
  passwordHashWith,
  rowsOf,
  seedActiveUser,
  seedPassword,
  softwareAuthenticator,
  totpCodeAt,
  type SoftwareAuthenticator,
} from './test-support.js';
import { confirmTotp, enrolTotp, removeTotp } from './totp.js';
import { hashHumanCode, hashToken, normaliseHumanCode } from './tokens.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

describe.each(testTargets)('auth audit events on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    // Through the service, as the server does at start-up, so its event is here.
    await ensureInstallation(database.db, {
      baseUrl: 'https://osfpm.example.test',
      now: T0,
    });
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;
  const authEvents = () =>
    db().select().from(auditEvent).where(like(auditEvent.category, 'auth.%'));
  const byCategory = async (category: string) =>
    (await authEvents()).filter((event) => event.category === category);

  /** Everything every flow below made secret: the raw values, and the hashes of them. */
  const secrets: string[] = [];
  /**
   * What the passkey flow stores on purpose, in `passkey_credential`, and so what
   * only the audit trail must not hold: credential ids, public keys, names.
   */
  const passkeyMaterial: string[] = [];

  let userId: string;
  let adminId: string;
  let firstSessionId: string;
  let keptSessionId: string;
  let setupCodeId: string;
  let passkeyUserId: string;
  let firstPasskeyId: string;
  let revokedPasskeyId: string;
  let setupOrganisationId: string;

  beforeAll(async () => {
    userId = await seedActiveUser(database);
    adminId = await seedActiveUser(database);

    // Sessions: create, revoke one, revoke the rest but one.
    const first = await createSession(db(), {
      userId,
      method: 'password+totp',
      userAgentSummary: 'Firefox on Windows',
      now: T0,
    });
    const second = await createSession(db(), {
      userId,
      method: 'passkey',
      now: at(MINUTE),
    });
    const third = await createSession(db(), {
      userId,
      method: 'recovery',
      now: at(MINUTE),
    });
    const fourth = await createSession(db(), {
      userId,
      method: 'password',
      now: at(MINUTE),
    });
    firstSessionId = first.session.id;
    keptSessionId = fourth.session.id;
    for (const { token } of [first, second, third, fourth]) {
      secrets.push(token, hashToken(token));
      await validateSession(db(), token, at(5 * MINUTE));
    }
    await revokeSession(db(), first.session.id, {
      reason: 'logout',
      now: at(10 * MINUTE),
    });
    await revokeUserSessions(db(), userId, {
      reason: 'password-changed',
      exceptSessionId: keptSessionId,
      now: at(11 * MINUTE),
    });

    // Disable and enable, by an administrator.
    await disableUser(db(), userId, {
      now: at(12 * MINUTE),
      actor: { type: 'user', id: adminId },
    });
    await enableUser(db(), userId, {
      now: at(13 * MINUTE),
      actor: { type: 'user', id: adminId },
    });

    // Recovery codes: generate, use one.
    const codes = await generateRecoveryCodes(db(), userId, {
      now: at(14 * MINUTE),
    });
    await consumeRecoveryCode(db(), userId, codes[0]!, {
      now: at(15 * MINUTE),
    });
    for (const code of codes) {
      secrets.push(code, normaliseHumanCode(code)!, hashHumanCode(code)!);
    }

    // Setup code: issue, replace, use.
    const stale = await issueSetupCode(db(), at(16 * MINUTE));
    const live = await issueSetupCode(db(), at(17 * MINUTE));
    await consumeSetupCode(db(), live, at(18 * MINUTE));
    for (const code of [stale, live]) {
      secrets.push(code, normaliseHumanCode(code)!, hashHumanCode(code)!);
    }
    const [issued] = (await byCategory(AUTH_AUDIT.setupCodeIssued)).sort(
      (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
    );
    setupCodeId = issued!.targetId!;

    // Passwords, an authenticator, the second step of a sign-in, and a recovery
    // session made full, all for one more user.
    const securityId = await seedActiveUser(database);
    const securityEmail = await emailOf(database, securityId);
    const firstPassword = 'cobblestone-heron-velvet-tide';
    const secondPassword = 'lantern-crane-quiet-morning';
    const typedPassword = 'wrong-password-typed-here';
    const typedEmail = 'nobody@demopictures.example';
    await setPassword(db(), {
      userId: securityId,
      newPassword: firstPassword,
      now: at(20 * MINUTE),
    });
    await verifyPasswordLogin(db(), {
      email: typedEmail,
      password: typedPassword,
      now: at(21 * MINUTE),
    });
    await verifyPasswordLogin(db(), {
      email: securityEmail,
      password: typedPassword,
      now: at(21 * MINUTE),
    });
    await verifyPasswordLogin(db(), {
      email: securityEmail,
      password: firstPassword,
      now: at(22 * MINUTE),
    });
    const enrolled = await enrolTotp(db(), securityId, {
      now: at(23 * MINUTE),
    });
    if (!enrolled.ok) throw new Error('the authenticator was not set up');
    await confirmTotp(db(), {
      userId: securityId,
      code: totpCodeAt(enrolled.secret, at(24 * MINUTE)),
      now: at(24 * MINUTE),
    });
    const { challenge } = await createLoginChallenge(db(), securityId, {
      kind: 'totp',
      now: at(25 * MINUTE),
    });
    await consumeLoginChallenge(db(), {
      challenge,
      code: totpCodeAt(enrolled.secret, at(25 * MINUTE)),
      now: at(25 * MINUTE),
    });
    const recovery = await createSession(db(), {
      userId: securityId,
      method: 'recovery',
      now: at(26 * MINUTE),
    });
    await setPassword(db(), {
      userId: securityId,
      newPassword: secondPassword,
      session: { id: recovery.session.id, scope: 'recovery' },
      now: at(27 * MINUTE),
    });
    // Removed again, so the secret is in no table by the end.
    await removeTotp(db(), {
      userId: securityId,
      password: secondPassword,
      session: { id: recovery.session.id },
      now: at(28 * MINUTE),
    });
    secrets.push(
      firstPassword,
      secondPassword,
      typedPassword,
      typedEmail,
      enrolled.secret,
      challenge,
      hashToken(challenge),
      recovery.token,
      hashToken(recovery.token),
    );

    // A password stored with older Argon2 parameters is stored again with the
    // current ones at its next sign-in.
    const legacyId = await seedActiveUser(database);
    const legacyPassword = 'ironwork-seagull-tidal-ember';
    await seedPassword(database, legacyId, legacyPassword, {
      hash: passwordHashWith(legacyPassword, {
        memoryKiB: 8192,
        passes: 1,
        parallelism: 1,
      }),
    });
    await verifyPasswordLogin(db(), {
      email: await emailOf(database, legacyId),
      password: legacyPassword,
      now: at(29 * MINUTE),
    });
    secrets.push(legacyPassword);

    // A password hash for the same sweep for secrets.
    const password = 'correct-horse-battery-harbour';
    secrets.push(password, await hashPassword(password));

    // Passkeys, for one more user: add two, sign in with one, fail once, name one
    // anew, and revoke it.
    passkeyUserId = await seedActiveUser(database);
    const relyingParty = relyingPartyFor('https://osfpm.example.test');
    const register = async (
      authenticator: SoftwareAuthenticator,
      deviceName: string,
      now: Date,
    ) => {
      const started = await startPasskeyRegistration(db(), {
        userId: passkeyUserId,
        relyingParty,
        now,
      });
      const finished = await finishPasskeyRegistration(db(), {
        userId: passkeyUserId,
        relyingParty,
        challenge: started.challenge,
        response: authenticator.register(started.options),
        deviceName,
        now,
      });
      if (!finished.ok) throw new Error('the passkey was not registered');
      secrets.push(started.challenge, hashToken(started.challenge));
      passkeyMaterial.push(
        authenticator.credentialId,
        Buffer.from(authenticator.publicKey).toString('base64url'),
        Buffer.from(authenticator.publicKey).toString('hex'),
        deviceName,
      );
      return finished.passkey.id;
    };
    const laptop = softwareAuthenticator();
    const tablet = softwareAuthenticator();
    firstPasskeyId = await register(
      laptop,
      'Production office laptop',
      at(30 * MINUTE),
    );
    revokedPasskeyId = await register(
      tablet,
      'Camera trailer tablet',
      at(31 * MINUTE),
    );
    const signIn = async (tweaks: { wrongSignature?: boolean }, now: Date) => {
      const started = await startPasskeyLogin(db(), { relyingParty, now });
      const response = laptop.authenticate(started.options, tweaks);
      await finishPasskeyLogin(db(), {
        relyingParty,
        challenge: started.challenge,
        response,
        now,
      });
      secrets.push(
        started.challenge,
        hashToken(started.challenge),
        response.response.signature,
      );
    };
    await signIn({}, at(32 * MINUTE));
    await signIn({ wrongSignature: true }, at(33 * MINUTE));
    await renamePasskey(db(), {
      userId: passkeyUserId,
      passkeyId: revokedPasskeyId,
      deviceName: 'Location scout phone',
      now: at(34 * MINUTE),
    });
    passkeyMaterial.push('Location scout phone');
    await revokePasskey(db(), {
      userId: passkeyUserId,
      passkeyId: revokedPasskeyId,
      now: at(35 * MINUTE),
    });

    // First-run setup, last, because it completes setup and the setup codes above
    // needed it incomplete: a check that fails, then the setup itself.
    for (const list of PERMISSION_LISTS) await syncPermissions(db(), list);
    await checkSetupCode(db(), 'AAAA-AAAA-AAAA-AAAA', at(36 * MINUTE));
    const firstRunCode = await issueSetupCode(db(), at(37 * MINUTE));
    const setup = await completeFirstRunSetup(
      db(),
      demoSetupInput(firstRunCode),
      at(38 * MINUTE),
    );
    if (!setup.ok) throw new Error('the setup was refused');
    setupOrganisationId = setup.organisation.id;
    secrets.push(
      firstRunCode,
      normaliseHumanCode(firstRunCode)!,
      hashHumanCode(firstRunCode)!,
      DEMO_ADMIN_PASSWORD,
    );
  });

  it('records every kind of action the services take', async () => {
    const seen = new Set((await authEvents()).map((event) => event.category));
    // From the list in code, so a new category without an event here fails.
    expect([...seen].sort()).toEqual(Object.values(AUTH_AUDIT).sort());
  });

  it('records a session as created, with its method, for its user', async () => {
    // The four sessions of this user; the one more user below has its own.
    const events = (await byCategory(AUTH_AUDIT.sessionCreated)).filter(
      (event) => event.actorId === userId,
    );
    expect(events).toHaveLength(4);
    const first = events.find((event) => event.targetId === firstSessionId);
    expect(first).toMatchObject({
      action: 'create',
      actorType: 'user',
      actorId: userId,
      targetType: 'session',
      details: { method: 'password+totp' },
      organisationId: null,
      projectId: null,
    });
    expect(first!.occurredAt).toEqual(T0);
  });

  it('records one revoked session with its reason', async () => {
    const events = await byCategory(AUTH_AUDIT.sessionRevoked);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'revoke',
      actorType: 'user',
      actorId: userId,
      targetType: 'session',
      targetId: firstSessionId,
      details: { reason: 'logout' },
    });
  });

  it('records the revocation of all sessions with the reason, the count and the session kept', async () => {
    // One from the call, one from disabling the user. The one more user below
    // has its own, which are about that user.
    const events = (await byCategory(AUTH_AUDIT.sessionsRevoked)).filter(
      (event) => event.targetId === userId,
    );
    expect(events).toHaveLength(2);
    const byReason = new Map(
      events.map((event) => [
        (event.details as { reason: string }).reason,
        event,
      ]),
    );
    expect(byReason.get('password-changed')).toMatchObject({
      action: 'revoke-all',
      actorType: 'user',
      actorId: userId,
      targetType: 'user',
      targetId: userId,
      details: {
        reason: 'password-changed',
        count: 2,
        exceptSessionId: keptSessionId,
      },
    });
    // The administrator who disabled the user did it, not the user.
    expect(byReason.get('user-disabled')).toMatchObject({
      actorType: 'user',
      actorId: adminId,
      details: { reason: 'user-disabled', count: 1, exceptSessionId: null },
    });
  });

  it('records a user disabled and enabled, by the administrator who did it', async () => {
    const [disabled] = await byCategory(AUTH_AUDIT.userDisabled);
    expect(disabled).toMatchObject({
      action: 'disable',
      actorType: 'user',
      actorId: adminId,
      targetType: 'user',
      targetId: userId,
      details: { previousStatus: 'active' },
    });
    expect(disabled!.occurredAt).toEqual(at(12 * MINUTE));
    const [enabled] = await byCategory(AUTH_AUDIT.userEnabled);
    expect(enabled).toMatchObject({
      action: 'enable',
      actorId: adminId,
      targetId: userId,
    });
    expect(enabled!.occurredAt).toEqual(at(13 * MINUTE));
  });

  it('records recovery codes generated and one used, with no code', async () => {
    const [generated] = await byCategory(AUTH_AUDIT.recoveryCodesGenerated);
    expect(generated).toMatchObject({
      action: 'generate',
      actorType: 'user',
      actorId: userId,
      targetId: userId,
      details: { count: 10 },
    });
    const used = await byCategory(AUTH_AUDIT.recoveryCodeUsed);
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({
      action: 'use',
      actorId: userId,
      targetType: 'recovery_code',
      details: null,
    });
    expect(used[0]!.occurredAt).toEqual(at(15 * MINUTE));
  });

  it('records setup codes issued (the second one replacing the first) and used', async () => {
    const issued = (await byCategory(AUTH_AUDIT.setupCodeIssued)).sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );
    // Two here, and the third that the first-run setup at the end of the flow used.
    expect(issued).toHaveLength(3);
    expect(issued[0]).toMatchObject({
      action: 'issue',
      actorType: 'system',
      actorId: null,
      targetType: 'setup_code',
      details: { replaced: 0 },
    });
    expect(issued[1]!.details).toMatchObject({ replaced: 1 });
    expect((issued[1]!.details as { expiresAt: string }).expiresAt).toBe(
      at(17 * MINUTE + 24 * 60 * MINUTE).toISOString(),
    );
    // The code before it had been used, so there was none live to replace.
    expect(issued[2]!.details).toMatchObject({ replaced: 0 });
    const used = (await byCategory(AUTH_AUDIT.setupCodeUsed)).filter(
      (event) => event.targetId === setupCodeId,
    );
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({
      action: 'use',
      actorType: 'system',
      targetType: 'setup_code',
      targetId: setupCodeId,
    });
  });

  it('records a failed check of the setup code, the installation made, and the first-run setup as one event for each part, with ids and no address', async () => {
    const [failed] = await byCategory(AUTH_AUDIT.setupCheckFailed);
    expect(failed).toMatchObject({
      action: 'check',
      actorType: 'system',
      actorId: null,
      targetType: null,
      targetId: null,
      details: { purpose: 'check' },
    });
    for (const category of [
      AUTH_AUDIT.installationCreated,
      AUTH_AUDIT.userCreated,
      AUTH_AUDIT.organisationCreated,
      AUTH_AUDIT.roleCreated,
      AUTH_AUDIT.membershipCreated,
      AUTH_AUDIT.setupCompleted,
    ]) {
      expect(await byCategory(category), category).toHaveLength(1);
    }
    const [completed] = await byCategory(AUTH_AUDIT.setupCompleted);
    expect(completed).toMatchObject({
      organisationId: setupOrganisationId,
      details: { organisationId: setupOrganisationId },
    });
    // The address is kept on the user and written in no event.
    expect(JSON.stringify(await db().select().from(auditEvent))).not.toContain(
      DEMO_ADMIN_EMAIL,
    );
  });

  it('records each passkey registration started and finished, for its user, with the passkey as the target of the second', async () => {
    const started = (
      await byCategory(AUTH_AUDIT.passkeyRegistrationStarted)
    ).filter((event) => event.targetId === passkeyUserId);
    expect(started).toHaveLength(2);
    expect(started[0]).toMatchObject({
      action: 'start',
      actorType: 'user',
      actorId: passkeyUserId,
      targetType: 'user',
      details: null,
    });
    const registered = (await byCategory(AUTH_AUDIT.passkeyRegistered)).filter(
      (event) => event.actorId === passkeyUserId,
    );
    expect(registered.map((event) => event.targetId).sort()).toEqual(
      [firstPasskeyId, revokedPasskeyId].sort(),
    );
    expect(registered[0]).toMatchObject({
      action: 'register',
      actorType: 'user',
      targetType: 'passkey_credential',
      details: null,
    });
  });

  it('records a passkey sign-in, and a failed one with its reason class only', async () => {
    const passed = (await byCategory(AUTH_AUDIT.loginStepPassed)).filter(
      (event) => event.targetId === passkeyUserId,
    );
    expect(passed).toHaveLength(1);
    expect(passed[0]).toMatchObject({
      action: 'pass',
      actorId: passkeyUserId,
      details: { method: 'passkey', next: 'session' },
    });
    const failed = (await byCategory(AUTH_AUDIT.loginStepFailed)).filter(
      (event) => event.targetId === passkeyUserId,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      action: 'fail',
      actorType: 'system',
      actorId: null,
      details: { method: 'passkey', reason: 'verification-failed' },
    });
  });

  it('records the rename and the revocation of a passkey, with the passkey as the target', async () => {
    const [renamed] = await byCategory(AUTH_AUDIT.passkeyRenamed);
    expect(renamed).toMatchObject({
      action: 'rename',
      actorId: passkeyUserId,
      targetType: 'passkey_credential',
      targetId: revokedPasskeyId,
      details: null,
    });
    const [revoked] = await byCategory(AUTH_AUDIT.passkeyRevoked);
    expect(revoked).toMatchObject({
      action: 'revoke',
      actorId: passkeyUserId,
      targetType: 'passkey_credential',
      targetId: revokedPasskeyId,
      details: null,
    });
  });

  it('holds no credential id, public key or passkey name in any event', async () => {
    // These are stored on purpose, in `passkey_credential`, so only the trail is
    // searched: the hashes and raw tokens are checked below, in every table.
    expect(passkeyMaterial.length).toBeGreaterThan(8);
    const text = JSON.stringify(await db().select().from(auditEvent));
    for (const material of passkeyMaterial) {
      expect(text, material.slice(0, 4)).not.toContain(material);
    }
  });

  it('writes no event for an attempt that changed nothing', async () => {
    const before = (await authEvents()).length;
    // Unknown and already-revoked sessions, a user already disabled or enabled,
    // wrong and spent codes: none of these changed anything.
    await revokeSession(db(), newId(), {
      reason: 'logout',
      now: at(20 * MINUTE),
    });
    await revokeSession(db(), firstSessionId, {
      reason: 'logout',
      now: at(20 * MINUTE),
    });
    await enableUser(db(), userId, { now: at(20 * MINUTE) });
    await consumeRecoveryCode(db(), userId, 'AAAA-AAAA-AAAA-AAAA', {
      now: at(20 * MINUTE),
    });
    await consumeSetupCode(db(), 'AAAA-AAAA-AAAA-AAAA', at(20 * MINUTE));
    expect((await authEvents()).length).toBe(before);
  });

  it('holds no token, code, hash or password in any event', async () => {
    expect(secrets.length).toBeGreaterThan(30);
    const text = JSON.stringify(await db().select().from(auditEvent));
    for (const secret of secrets) {
      expect(text, secret.slice(0, 4)).not.toContain(secret);
    }
  });

  it('holds no raw token, code or password in any table, only hashes', async () => {
    const text = await everyRowAsText(database);
    // The raw values only: the hashes are meant to be stored.
    const raw = secrets.filter(
      (secret) =>
        !/^[0-9a-f]{64}$/.test(secret) && !secret.startsWith('$argon2'),
    );
    expect(raw.length).toBeGreaterThan(15);
    for (const secret of raw) {
      expect(text, secret.slice(0, 4)).not.toContain(secret);
    }
  });

  it('keeps all of this out of the change log: the only changes in it are the tenant records the first-run setup made', async () => {
    const found = await rowsOf(
      database,
      sql`select distinct entity_type from change_event`,
    );
    const types = found.map((row) => String(row.entity_type));
    expect(types.length).toBeGreaterThan(0);
    // Tenant tables alone: no security table, and neither `user` nor `installation`.
    for (const type of types) {
      expect(tenantTableNames().has(type), type).toBe(true);
    }
    // The one counter is the new organisation's own; no other flow took one.
    const counters = await rowsOf(
      database,
      sql`select organisation_id, project_id from change_seq`,
    );
    expect(counters).toEqual([
      { organisation_id: setupOrganisationId, project_id: null },
    ]);
    for (const table of SECURITY_TABLES) {
      const [found] = await rowsOf(
        database,
        sql`select count(*)::int as n from change_event
            where entity_type = ${getTableName(table)}`,
      );
      expect(found!.n, getTableName(table)).toBe(0);
    }
  });
});
