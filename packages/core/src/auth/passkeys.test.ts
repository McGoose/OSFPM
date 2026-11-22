import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  auditEvent,
  loginChallenge,
  passkeyCredential,
  session,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { AuthInputError, AuthStateError } from './errors.js';
import { createLoginChallenge, LOGIN_CHALLENGE } from './login-challenge.js';
import {
  finishPasskeyLogin,
  finishPasskeyRegistration,
  listPasskeys,
  PASSKEY_SETTINGS,
  relyingPartyFor,
  renamePasskey,
  revokePasskey,
  startPasskeyLogin,
  startPasskeyRegistration,
} from './passkeys.js';
import { createSession } from './sessions.js';
import { AUTH_AUDIT } from './shared.js';
import { isThrottled } from './throttle.js';
import {
  everyRowAsText,
  markUserDeleted,
  seedActiveUser,
  seedInstallation,
  seedPassword,
  setUserStatus,
  softwareAuthenticator,
  emailOf,
  type AuthenticationTweaks,
  type RegistrationTweaks,
  type SoftwareAuthenticator,
} from './test-support.js';
import { generateToken, hashToken } from './tokens.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** The relying party of every test: an invented site. */
const RP = relyingPartyFor('https://osfpm.example.test');

/** The user handle the server gives an authenticator for a user: the 16 bytes of the id. */
const userHandleOf = (userId: string) =>
  Buffer.from(userId.replaceAll('-', ''), 'hex').toString('base64url');

describe('relyingPartyFor', () => {
  it('takes the host name as the id, the origin as the origin and OSFPM as the name', () => {
    expect(relyingPartyFor('https://osfpm.example.test')).toEqual({
      id: 'osfpm.example.test',
      name: 'OSFPM',
      origin: 'https://osfpm.example.test',
    });
  });

  it('keeps the port in the origin and leaves it out of the id', () => {
    expect(relyingPartyFor('http://localhost:3000')).toEqual({
      id: 'localhost',
      name: 'OSFPM',
      origin: 'http://localhost:3000',
    });
  });

  it('leaves the path, the query and a default port out of the origin', () => {
    expect(
      relyingPartyFor('https://Osfpm.Example.Test:443/app/?x=1#top'),
    ).toEqual({
      id: 'osfpm.example.test',
      name: 'OSFPM',
      origin: 'https://osfpm.example.test',
    });
  });

  it('gives another id for another host, which is why a passkey stops working when the host changes', () => {
    expect(relyingPartyFor('https://films.example.test').id).not.toBe(
      relyingPartyFor('https://osfpm.example.test').id,
    );
  });

  it('refuses text that is not a URL', () => {
    expect(() => relyingPartyFor('not a url')).toThrow();
  });
});

describe('PASSKEY_SETTINGS', () => {
  it('allows ES256 and RS256 and a device name of up to 100 characters', () => {
    expect(PASSKEY_SETTINGS.algorithms).toEqual([-7, -257]);
    expect(PASSKEY_SETTINGS.maxDeviceNameLength).toBe(100);
    expect(PASSKEY_SETTINGS.relyingPartyName).toBe('OSFPM');
  });
});

describe.each(testTargets)('passkeys on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    await seedInstallation(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;

  const challengeRow = async (challenge: string) => {
    const [row] = await db()
      .select()
      .from(loginChallenge)
      .where(eq(loginChallenge.tokenHash, hashToken(challenge)));
    return row;
  };
  const passkeyRow = async (credentialId: string) => {
    const [row] = await db()
      .select()
      .from(passkeyCredential)
      .where(eq(passkeyCredential.credentialId, credentialId));
    return row;
  };
  const passkeysOf = (userId: string) =>
    db()
      .select()
      .from(passkeyCredential)
      .where(eq(passkeyCredential.userId, userId));
  const events = async (category: string) =>
    (await db().select().from(auditEvent)).filter(
      (event) => event.category === category,
    );
  const countRows = async () => ({
    challenges: (await db().select().from(loginChallenge)).length,
    audit: (await db().select().from(auditEvent)).length,
    passkeys: (await db().select().from(passkeyCredential)).length,
  });

  const start = (userId: string, now = T0) =>
    startPasskeyRegistration(db(), { userId, relyingParty: RP, now });

  /** Finishes a registration with what `authenticator` answers to `started`. */
  const finish = (
    userId: string,
    started: Awaited<ReturnType<typeof start>>,
    authenticator: SoftwareAuthenticator,
    extra: {
      tweaks?: RegistrationTweaks;
      now?: Date;
      deviceName?: string | null;
      session?: { id: string; scope: 'full' | 'recovery' };
    } = {},
  ) =>
    finishPasskeyRegistration(db(), {
      userId,
      relyingParty: RP,
      challenge: started.challenge,
      response: authenticator.register(started.options, extra.tweaks),
      ...(extra.deviceName === undefined
        ? {}
        : { deviceName: extra.deviceName }),
      ...(extra.session === undefined ? {} : { session: extra.session }),
      now: extra.now ?? at(SECOND),
    });

  /** Adds a passkey for `userId` the way a person does, and returns it with its authenticator. */
  async function addPasskey(
    userId: string,
    options: {
      authenticator?: SoftwareAuthenticator;
      deviceName?: string | null;
      now?: Date;
    } = {},
  ) {
    const authenticator = options.authenticator ?? softwareAuthenticator();
    const now = options.now ?? T0;
    const started = await start(userId, now);
    const finished = await finish(userId, started, authenticator, {
      ...(options.deviceName === undefined
        ? {}
        : { deviceName: options.deviceName }),
      now,
    });
    if (!finished.ok) throw new Error('the registration was refused');
    return { authenticator, passkey: finished.passkey };
  }

  describe('startPasskeyRegistration', () => {
    it('returns the options for a discoverable passkey with user verification and a challenge that ends in five minutes', async () => {
      const userId = await seedActiveUser(database);
      const started = await start(userId);
      expect(started.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(started.expiresAt).toEqual(at(LOGIN_CHALLENGE.ttlMs));
      const { options } = started;
      // The challenge the client sends back is the one the authenticator signs.
      expect(options.challenge).toBe(started.challenge);
      expect(options.rp).toEqual({ id: 'osfpm.example.test', name: 'OSFPM' });
      expect(options.attestation).toBe('none');
      expect(options.authenticatorSelection).toMatchObject({
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      });
      expect(options.pubKeyCredParams).toEqual([
        { alg: -7, type: 'public-key' },
        { alg: -257, type: 'public-key' },
      ]);
      expect(options.excludeCredentials).toEqual([]);
      expect(options.user).toEqual({
        id: userHandleOf(userId),
        name: await emailOf(database, userId),
        displayName: expect.stringMatching(/^Fixture User \d+$/) as string,
      });
    });

    it('stores only the hash of the challenge, for the user, and keeps the raw value out of every table', async () => {
      const userId = await seedActiveUser(database);
      const started = await start(userId);
      expect(await challengeRow(started.challenge)).toMatchObject({
        userId,
        kind: 'webauthn-register',
        attempts: 0,
        usedAt: null,
        expiresAt: at(LOGIN_CHALLENGE.ttlMs),
      });
      expect(await everyRowAsText(database)).not.toContain(started.challenge);
    });

    it('makes a different challenge every time', async () => {
      const userId = await seedActiveUser(database);
      const first = await start(userId);
      const second = await start(userId);
      expect(first.challenge).not.toBe(second.challenge);
    });

    it('excludes the live passkeys of the user, with their transports, and no one else’s and no revoked one', async () => {
      const userId = await seedActiveUser(database);
      const other = await seedActiveUser(database);
      const first = await addPasskey(userId);
      const second = await addPasskey(userId);
      const revoked = await addPasskey(userId);
      await addPasskey(other);
      await db()
        .update(passkeyCredential)
        .set({ revokedAt: T0 })
        .where(eq(passkeyCredential.id, revoked.passkey.id));
      const { options } = await start(userId, at(MINUTE));
      expect(options.excludeCredentials).toEqual([
        {
          id: first.authenticator.credentialId,
          transports: ['internal'],
          type: 'public-key',
        },
        {
          id: second.authenticator.credentialId,
          transports: ['internal'],
          type: 'public-key',
        },
      ]);
    });

    it('audits the start, for the user, and writes nothing secret into the event', async () => {
      const userId = await seedActiveUser(database);
      const started = await start(userId, at(MINUTE));
      const found = (
        await events(AUTH_AUDIT.passkeyRegistrationStarted)
      ).filter((event) => event.targetId === userId);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        action: 'start',
        actorType: 'user',
        actorId: userId,
        targetType: 'user',
        targetId: userId,
        organisationId: null,
      });
      expect(found[0]!.occurredAt).toEqual(at(MINUTE));
      expect(JSON.stringify(found[0])).not.toContain(started.challenge);
    });

    it('refuses an unknown, a deleted and a disabled user, writing nothing', async () => {
      const deleted = await seedActiveUser(database);
      await markUserDeleted(database, deleted);
      const disabled = await seedActiveUser(database);
      await setUserStatus(database, disabled, 'disabled');
      const before = await countRows();
      await expect(start(newId())).rejects.toMatchObject({
        reason: 'user-not-found',
      });
      await expect(start(deleted)).rejects.toMatchObject({
        reason: 'user-not-found',
      });
      await expect(start(disabled)).rejects.toMatchObject({
        reason: 'user-disabled',
      });
      await expect(start(disabled)).rejects.toBeInstanceOf(AuthStateError);
      expect(await countRows()).toEqual(before);
    });

    it('removes the expired challenges of this user when it makes a new one, and leaves other users’ alone', async () => {
      const userId = await seedActiveUser(database);
      const other = await seedActiveUser(database);
      const old = await start(userId, T0);
      const othersOld = await start(other, T0);
      const live = await start(userId, at(2 * MINUTE));
      const fresh = await start(userId, at(LOGIN_CHALLENGE.ttlMs));
      expect(await challengeRow(old.challenge)).toBeUndefined();
      expect(await challengeRow(live.challenge)).toBeDefined();
      expect(await challengeRow(fresh.challenge)).toBeDefined();
      expect(await challengeRow(othersOld.challenge)).toBeDefined();
    });
  });

  describe('finishPasskeyRegistration', () => {
    it('stores the credential for the user, returns a summary with no key material, and uses the challenge up', async () => {
      const userId = await seedActiveUser(database);
      const authenticator = softwareAuthenticator();
      const started = await start(userId);
      const finished = await finish(userId, started, authenticator, {
        deviceName: '  Production office laptop  ',
        now: at(SECOND),
      });
      expect(finished.ok).toBe(true);
      if (!finished.ok) return;
      expect(finished.passkey).toEqual({
        id: expect.any(String) as string,
        deviceName: 'Production office laptop',
        createdAt: at(SECOND),
        lastUsedAt: null,
        transports: ['internal'],
      });
      const row = await passkeyRow(authenticator.credentialId);
      expect(row).toMatchObject({
        id: finished.passkey.id,
        userId,
        credentialId: authenticator.credentialId,
        signCount: 0,
        transports: ['internal'],
        deviceName: 'Production office laptop',
        lastUsedAt: null,
        revokedAt: null,
        createdBy: userId,
        updatedBy: userId,
      });
      // The key is stored as the COSE bytes the authenticator made.
      expect([...row!.publicKey]).toEqual([...authenticator.publicKey]);
      expect(await challengeRow(started.challenge)).toMatchObject({
        usedAt: at(SECOND),
      });
    });

    it('audits the registration with the passkey as its target, and writes no credential id, key or challenge into any event', async () => {
      const userId = await seedActiveUser(database);
      const authenticator = softwareAuthenticator();
      const started = await start(userId);
      const finished = await finish(userId, started, authenticator);
      if (!finished.ok) throw new Error('refused');
      const found = (await events(AUTH_AUDIT.passkeyRegistered)).filter(
        (event) => event.actorId === userId,
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        action: 'register',
        actorType: 'user',
        targetType: 'passkey_credential',
        targetId: finished.passkey.id,
        organisationId: null,
      });
      const everything = JSON.stringify(await db().select().from(auditEvent));
      for (const secret of [
        started.challenge,
        hashToken(started.challenge),
        authenticator.credentialId,
        Buffer.from(authenticator.publicKey).toString('base64url'),
        Buffer.from(authenticator.publicKey).toString('base64'),
        Buffer.from(authenticator.publicKey).toString('hex'),
      ]) {
        expect(everything).not.toContain(secret);
      }
    });

    it('leaves the name empty when none is given or it is blank', async () => {
      const userId = await seedActiveUser(database);
      for (const deviceName of [undefined, null, '', '   ']) {
        const { passkey } = await addPasskey(userId, {
          ...(deviceName === undefined ? {} : { deviceName }),
        });
        expect(passkey.deviceName).toBeNull();
      }
    });

    it('refuses a name that is too long or holds a control character, before it touches the challenge', async () => {
      const userId = await seedActiveUser(database);
      const authenticator = softwareAuthenticator();
      const started = await start(userId);
      const before = await countRows();
      for (const deviceName of [
        'x'.repeat(PASSKEY_SETTINGS.maxDeviceNameLength + 1),
        `line${String.fromCodePoint(10)}break`,
        `bell${String.fromCodePoint(7)}`,
      ]) {
        await expect(
          finish(userId, started, authenticator, { deviceName }),
        ).rejects.toBeInstanceOf(AuthInputError);
      }
      expect(await countRows()).toEqual(before);
      expect((await challengeRow(started.challenge))!.usedAt).toBeNull();
      // A name of exactly the longest length is fine.
      const longest = await finish(userId, started, authenticator, {
        deviceName: 'x'.repeat(PASSKEY_SETTINGS.maxDeviceNameLength),
      });
      expect(longest.ok).toBe(true);
    });

    it('keeps only the transports it knows, once each', async () => {
      const userId = await seedActiveUser(database);
      const authenticator = softwareAuthenticator();
      const started = await start(userId);
      const finished = await finish(userId, started, authenticator, {
        tweaks: {
          transports: ['usb', 'bogus', 'internal', 'usb', '__proto__'],
        },
      });
      if (!finished.ok) throw new Error('refused');
      expect(finished.passkey.transports).toEqual(['usb', 'internal']);
    });

    it('accepts an RS256 key', async () => {
      const userId = await seedActiveUser(database);
      const { authenticator } = await addPasskey(userId, {
        authenticator: softwareAuthenticator({ algorithm: 'RS256' }),
      });
      const row = await passkeyRow(authenticator.credentialId);
      expect([...row!.publicKey]).toEqual([...authenticator.publicKey]);
    });

    const refusals: [string, RegistrationTweaks | 'eddsa'][] = [
      ['another origin', { origin: 'https://evil.example.test' }],
      ['another relying party id', { rpId: 'evil.example.test' }],
      ['no user verification', { userVerified: false }],
      ['no user presence', { userPresent: false }],
      [
        'another challenge in the client data',
        { challenge: 'bm90LXRoZS1jaGFsbGVuZ2U' },
      ],
      ['a key type the server does not accept', 'eddsa'],
    ];
    it.each(refusals)(
      'refuses a registration with %s, stores nothing and uses the challenge up',
      async (_name, refusal) => {
        const userId = await seedActiveUser(database);
        const authenticator =
          refusal === 'eddsa'
            ? softwareAuthenticator({ algorithm: 'EdDSA' })
            : softwareAuthenticator();
        const started = await start(userId);
        const before = await passkeysOf(userId);
        const finished = await finish(userId, started, authenticator, {
          ...(refusal === 'eddsa' ? {} : { tweaks: refusal }),
        });
        // A refusal is a value, not a throw, so the caller's transaction commits.
        expect(finished).toEqual({ ok: false });
        expect(await passkeysOf(userId)).toEqual(before);
        expect(await challengeRow(started.challenge)).toMatchObject({
          usedAt: at(SECOND),
        });
        // The same challenge does not work again, even for a right response.
        expect(
          await finish(userId, started, softwareAuthenticator(), {
            now: at(2 * SECOND),
          }),
        ).toEqual({ ok: false });
      },
    );

    it('refuses a challenge that was already used, and stores one passkey only', async () => {
      const userId = await seedActiveUser(database);
      const started = await start(userId);
      expect((await finish(userId, started, softwareAuthenticator())).ok).toBe(
        true,
      );
      expect(
        await finish(userId, started, softwareAuthenticator(), {
          now: at(2 * SECOND),
        }),
      ).toEqual({ ok: false });
      expect(await passkeysOf(userId)).toHaveLength(1);
    });

    it('refuses an expired challenge, one that ends at the time included, and takes one a moment before', async () => {
      const userId = await seedActiveUser(database);
      const ended = await start(userId, T0);
      expect(
        await finish(userId, ended, softwareAuthenticator(), {
          now: at(LOGIN_CHALLENGE.ttlMs),
        }),
      ).toEqual({ ok: false });
      const justInTime = await start(userId, T0);
      expect(
        (
          await finish(userId, justInTime, softwareAuthenticator(), {
            now: at(LOGIN_CHALLENGE.ttlMs - 1),
          })
        ).ok,
      ).toBe(true);
    });

    it('refuses the challenge of another user, and leaves it for its owner', async () => {
      const owner = await seedActiveUser(database);
      const thief = await seedActiveUser(database);
      const started = await start(owner);
      const authenticator = softwareAuthenticator();
      expect(await finish(thief, started, authenticator)).toEqual({
        ok: false,
      });
      expect(await passkeysOf(thief)).toEqual([]);
      expect((await challengeRow(started.challenge))!.usedAt).toBeNull();
      expect((await finish(owner, started, authenticator)).ok).toBe(true);
    });

    it('refuses the token of another kind of challenge, and leaves it untouched', async () => {
      const userId = await seedActiveUser(database);
      const { challenge } = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: T0,
      });
      const started = await start(userId);
      const response = softwareAuthenticator().register(started.options);
      expect(
        await finishPasskeyRegistration(db(), {
          userId,
          relyingParty: RP,
          challenge,
          response,
          now: at(SECOND),
        }),
      ).toEqual({ ok: false });
      expect(await challengeRow(challenge)).toMatchObject({
        kind: 'totp',
        attempts: 0,
        usedAt: null,
      });
    });

    it('refuses a challenge nobody made, one that is not shaped like one, and an overlong one', async () => {
      const userId = await seedActiveUser(database);
      const started = await start(userId);
      const response = softwareAuthenticator().register(started.options);
      for (const challenge of [generateToken(), '', 'x'.repeat(300)]) {
        expect(
          await finishPasskeyRegistration(db(), {
            userId,
            relyingParty: RP,
            challenge,
            response,
            now: at(SECOND),
          }),
        ).toEqual({ ok: false });
      }
      expect((await challengeRow(started.challenge))!.usedAt).toBeNull();
    });

    it('refuses a credential that is already registered, for the same user or another, and keeps the first', async () => {
      const userId = await seedActiveUser(database);
      const other = await seedActiveUser(database);
      const { authenticator, passkey } = await addPasskey(userId);
      // An authenticator that ignores `excludeCredentials` answers with the same credential.
      const again = await start(userId, at(MINUTE));
      expect(
        await finish(userId, again, authenticator, { now: at(MINUTE) }),
      ).toEqual({ ok: false });
      // Another user's authenticator that has the same credential id, as an attacker's could.
      const stolenId = softwareAuthenticator({
        credentialId: authenticator.credentialId,
      });
      const theirs = await start(other, at(MINUTE));
      expect(
        await finish(other, theirs, stolenId, { now: at(MINUTE) }),
      ).toEqual({ ok: false });
      expect(await passkeysOf(other)).toEqual([]);
      const row = await passkeyRow(authenticator.credentialId);
      expect(row).toMatchObject({ id: passkey.id, userId });
      expect([...row!.publicKey]).toEqual([...authenticator.publicKey]);
    });

    it('refuses a disabled or deleted user and leaves the challenge unused', async () => {
      const disabled = await seedActiveUser(database);
      const started = await start(disabled);
      await setUserStatus(database, disabled, 'disabled');
      await expect(
        finish(disabled, started, softwareAuthenticator()),
      ).rejects.toMatchObject({ reason: 'user-disabled' });
      expect((await challengeRow(started.challenge))!.usedAt).toBeNull();
      const deleted = await seedActiveUser(database);
      const second = await start(deleted);
      await markUserDeleted(database, deleted);
      await expect(
        finish(deleted, second, softwareAuthenticator()),
      ).rejects.toMatchObject({ reason: 'user-not-found' });
      expect(await passkeysOf(disabled)).toEqual([]);
      expect(await passkeysOf(deleted)).toEqual([]);
    });

    describe('a recovery session', () => {
      const recoverySession = async (userId: string) => {
        const created = await createSession(db(), {
          userId,
          method: 'recovery',
          now: T0,
        });
        return created.session;
      };
      const scopeOf = async (sessionId: string) => {
        const [row] = await db()
          .select({ scope: session.scope })
          .from(session)
          .where(eq(session.id, sessionId));
        return row!.scope;
      };
      const promotions = async (sessionId: string) =>
        (await events(AUTH_AUDIT.sessionPromoted)).filter(
          (event) => event.targetId === sessionId,
        );

      it('becomes a full session once a passkey is registered, and the event says why', async () => {
        const userId = await seedActiveUser(database);
        const { id } = await recoverySession(userId);
        const started = await start(userId);
        const finished = await finish(
          userId,
          started,
          softwareAuthenticator(),
          {
            session: { id, scope: 'recovery' },
          },
        );
        expect(finished.ok).toBe(true);
        expect(await scopeOf(id)).toBe('full');
        const [promoted] = await promotions(id);
        expect(promoted).toMatchObject({
          details: {
            from: 'recovery',
            to: 'full',
            trigger: 'passkey-registered',
          },
        });
      });

      it('stays a recovery session when the registration is refused', async () => {
        const userId = await seedActiveUser(database);
        const { id } = await recoverySession(userId);
        const started = await start(userId);
        const finished = await finish(
          userId,
          started,
          softwareAuthenticator(),
          {
            session: { id, scope: 'recovery' },
            tweaks: { origin: 'https://evil.example.test' },
          },
        );
        expect(finished).toEqual({ ok: false });
        expect(await scopeOf(id)).toBe('recovery');
        expect(await promotions(id)).toEqual([]);
      });

      it('changes nothing for a session that is already full', async () => {
        const userId = await seedActiveUser(database);
        const created = await createSession(db(), {
          userId,
          method: 'password',
          now: T0,
        });
        const started = await start(userId);
        const finished = await finish(
          userId,
          started,
          softwareAuthenticator(),
          {
            session: { id: created.session.id, scope: 'full' },
          },
        );
        expect(finished.ok).toBe(true);
        expect(await promotions(created.session.id)).toEqual([]);
      });

      it('does not end the user’s other sessions: a passkey adds a way in, it does not remove one', async () => {
        const userId = await seedActiveUser(database);
        const other = await createSession(db(), {
          userId,
          method: 'password',
          now: T0,
        });
        const { id } = await recoverySession(userId);
        const started = await start(userId);
        await finish(userId, started, softwareAuthenticator(), {
          session: { id, scope: 'recovery' },
        });
        const [row] = await db()
          .select({ revokedAt: session.revokedAt })
          .from(session)
          .where(eq(session.id, other.session.id));
        expect(row!.revokedAt).toBeNull();
      });
    });
  });

  describe('startPasskeyLogin', () => {
    const startLogin = (now = T0) =>
      startPasskeyLogin(db(), { relyingParty: RP, now });

    it('returns the options for a sign-in that names no credential, and a challenge that ends in five minutes', async () => {
      const started = await startLogin();
      expect(started.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(started.expiresAt).toEqual(at(LOGIN_CHALLENGE.ttlMs));
      const { options } = started;
      expect(options.challenge).toBe(started.challenge);
      expect(options.rpId).toBe('osfpm.example.test');
      expect(options.userVerification).toBe('required');
      // The device offers its own passkeys for this site: no list of ids, and so
      // no way to find out which ids exist.
      expect(options.allowCredentials ?? []).toEqual([]);
    });

    it('stores only the hash of the challenge, tied to no user, and keeps the raw value out of every table', async () => {
      const started = await startLogin();
      expect(await challengeRow(started.challenge)).toMatchObject({
        userId: null,
        kind: 'webauthn-login',
        attempts: 0,
        usedAt: null,
        expiresAt: at(LOGIN_CHALLENGE.ttlMs),
      });
      expect(await everyRowAsText(database)).not.toContain(started.challenge);
    });

    it('makes a different challenge every time and writes no audit event: nobody has signed in or failed', async () => {
      const before = await countRows();
      const first = await startLogin();
      const second = await startLogin();
      expect(first.challenge).not.toBe(second.challenge);
      expect((await countRows()).audit).toBe(before.audit);
    });
  });

  describe('finishPasskeyLogin', () => {
    const startLogin = (now = T0) =>
      startPasskeyLogin(db(), { relyingParty: RP, now });

    /** Finishes a sign-in with what `authenticator` answers to `started`. */
    const signIn = (
      started: Awaited<ReturnType<typeof startLogin>>,
      authenticator: SoftwareAuthenticator,
      extra: {
        tweaks?: AuthenticationTweaks;
        now?: Date;
        challenge?: string;
      } = {},
    ) =>
      finishPasskeyLogin(db(), {
        relyingParty: RP,
        challenge: extra.challenge ?? started.challenge,
        response: authenticator.authenticate(started.options, extra.tweaks),
        now: extra.now ?? at(SECOND),
      });

    /** A user with one passkey, registered at T0. */
    async function userWithPasskey(
      options: { counts?: boolean; algorithm?: 'ES256' | 'RS256' } = {},
    ) {
      const userId = await seedActiveUser(database);
      const added = await addPasskey(userId, {
        authenticator: softwareAuthenticator(options),
      });
      return { userId, ...added };
    }

    const storedPasskey = async (id: string) => {
      const [row] = await db()
        .select()
        .from(passkeyCredential)
        .where(eq(passkeyCredential.id, id));
      return row!;
    };
    const failures = async () =>
      (await events(AUTH_AUDIT.loginStepFailed)).filter(
        (event) =>
          (event.details as { method?: string } | null)?.method === 'passkey',
      );
    // The newest by id, not by time: ids are UUIDv7, so they follow the order the
    // events were written in, and the tests share one database and reuse times.
    const lastFailure = async () => {
      const all = (await failures()).sort((a, b) => a.id.localeCompare(b.id));
      return all[all.length - 1]!;
    };

    it('signs the user in without an address, returning only what a signed-in client needs, and audits the step', async () => {
      const { userId, authenticator, passkey } = await userWithPasskey();
      const started = await startLogin();
      const result = await signIn(started, authenticator, { now: at(MINUTE) });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The passkey that signed in, so the session can be tied to it.
      expect(result.passkeyId).toBe(passkey.id);
      expect(Object.keys(result.user).sort()).toEqual([
        'displayName',
        'email',
        'id',
        'locale',
        'status',
        'timezone',
      ]);
      expect(result.user).toMatchObject({
        id: userId,
        email: await emailOf(database, userId),
        status: 'active',
      });
      // The challenge is used up, and the passkey records the use.
      expect(await challengeRow(started.challenge)).toMatchObject({
        usedAt: at(MINUTE),
      });
      expect(await storedPasskey(passkey.id)).toMatchObject({
        signCount: 1,
        lastUsedAt: at(MINUTE),
      });
      const passed = (await events(AUTH_AUDIT.loginStepPassed)).filter(
        (event) =>
          event.targetId === userId &&
          (event.details as { method?: string }).method === 'passkey',
      );
      expect(passed).toHaveLength(1);
      expect(passed[0]).toMatchObject({
        action: 'pass',
        actorType: 'user',
        actorId: userId,
        targetType: 'user',
        details: { method: 'passkey', next: 'session' },
      });
      expect(passed[0]!.occurredAt).toEqual(at(MINUTE));
    });

    it('finds each user from the credential, among several users with passkeys', async () => {
      const first = await userWithPasskey();
      const second = await userWithPasskey({ algorithm: 'RS256' });
      for (const one of [second, first]) {
        const started = await startLogin();
        expect(await signIn(started, one.authenticator)).toMatchObject({
          ok: true,
          user: { id: one.userId },
        });
      }
    });

    describe('the user handle', () => {
      // WebAuthn, section 7.2: a response that carries a user handle must carry
      // the one of the credential's owner. The account is still found from the
      // credential id; the handle is a check on it.
      it('is accepted when it is the owner’s, in either spelling, and when the response carries none', async () => {
        const { userId, authenticator } = await userWithPasskey();
        const own = userHandleOf(userId);
        for (const userHandle of [undefined, null, own, `${own}==`]) {
          const started = await startLogin();
          expect(
            await signIn(started, authenticator, {
              ...(userHandle === undefined ? {} : { tweaks: { userHandle } }),
            }),
          ).toMatchObject({ ok: true, user: { id: userId } });
        }
      });

      it('is refused when it is another user’s or is no handle of anyone, as verification-failed, and the challenge is used up', async () => {
        const mine = await userWithPasskey();
        const other = await userWithPasskey();
        for (const userHandle of [
          userHandleOf(other.userId),
          'bm90LXRoZS1oYW5kbGU',
          // The owner's handle with its first character changed.
          userHandleOf(mine.userId).replace(/^./, (c) =>
            c === 'B' ? 'C' : 'B',
          ),
        ]) {
          const started = await startLogin();
          expect(
            await signIn(started, mine.authenticator, {
              tweaks: { userHandle },
            }),
          ).toEqual({ ok: false });
          expect(await lastFailure()).toMatchObject({
            targetId: mine.userId,
            details: { method: 'passkey', reason: 'verification-failed' },
          });
          expect(
            (await challengeRow(started.challenge))!.usedAt,
          ).not.toBeNull();
        }
        // Nothing was stored for the passkey, and it still signs in with its own handle.
        expect((await storedPasskey(mine.passkey.id)).signCount).toBe(0);
        const started = await startLogin();
        expect(await signIn(started, mine.authenticator)).toMatchObject({
          ok: true,
        });
      });
    });

    describe('the signature counter', () => {
      it('is stored as it goes up', async () => {
        const { authenticator, passkey } = await userWithPasskey();
        for (let count = 1; count <= 3; count += 1) {
          const started = await startLogin();
          expect(await signIn(started, authenticator)).toMatchObject({
            ok: true,
          });
          expect((await storedPasskey(passkey.id)).signCount).toBe(count);
        }
      });

      it('accepts a device that never counts: 0 after 0, every time, and still records the use', async () => {
        const { authenticator, passkey } = await userWithPasskey({
          counts: false,
        });
        for (let i = 1; i <= 3; i += 1) {
          const started = await startLogin();
          expect(
            await signIn(started, authenticator, { now: at(i * MINUTE) }),
          ).toMatchObject({ ok: true });
          expect(await storedPasskey(passkey.id)).toMatchObject({
            signCount: 0,
            lastUsedAt: at(i * MINUTE),
          });
        }
      });

      it('accepts a first count after a registration that reported 0, and a count that jumps', async () => {
        const { authenticator, passkey } = await userWithPasskey();
        const started = await startLogin();
        await signIn(started, authenticator, { tweaks: { signCount: 40 } });
        expect((await storedPasskey(passkey.id)).signCount).toBe(40);
      });

      const regressions: [string, number][] = [
        ['the same count', 3],
        ['a lower count', 2],
        // The WebAuthn rule (section 7.2) is that either count above 0 and a new
        // count that is not higher is a sign of a clone: a count back at 0 after
        // counting is one too.
        ['a count back at 0 after counting', 0],
      ];
      it.each(regressions)(
        'refuses %s as a possible cloned key, keeps the stored count, and audits it',
        async (_name, reported) => {
          const { userId, authenticator, passkey } = await userWithPasskey();
          for (let i = 0; i < 3; i += 1) {
            await signIn(await startLogin(), authenticator);
          }
          expect((await storedPasskey(passkey.id)).signCount).toBe(3);
          const lastUse = (await storedPasskey(passkey.id)).lastUsedAt;
          const started = await startLogin(at(10 * MINUTE));
          const result = await signIn(started, authenticator, {
            tweaks: { signCount: reported },
            now: at(10 * MINUTE),
          });
          expect(result).toEqual({ ok: false });
          expect(await storedPasskey(passkey.id)).toMatchObject({
            signCount: 3,
            lastUsedAt: lastUse,
          });
          expect(await lastFailure()).toMatchObject({
            actorType: 'system',
            targetType: 'user',
            targetId: userId,
            details: { method: 'passkey', reason: 'counter-regressed' },
          });
          // The challenge is used, and the passkey is not revoked: the next sign-in
          // with a count that goes up works.
          expect(await challengeRow(started.challenge)).toMatchObject({
            usedAt: at(10 * MINUTE),
          });
          expect(
            await signIn(await startLogin(), authenticator, {
              tweaks: { signCount: 4 },
            }),
          ).toMatchObject({ ok: true });
        },
      );
    });

    /** How a refusal case sets things up, and whether the audit event names the user. */
    type Arrangement = {
      tweaks?: AuthenticationTweaks;
      challenge?: (started: { challenge: string }) => string | Promise<string>;
      authenticator?: SoftwareAuthenticator;
      /** True when the server knows whose credential it is, so the event targets the user. */
      targeted: boolean;
    };
    const failureCases: [
      string,
      string,
      (context: {
        userId: string;
        passkeyId: string;
        authenticator: SoftwareAuthenticator;
      }) => Promise<Arrangement>,
    ][] = [
      [
        'a credential the server does not have',
        'unknown-credential',
        () =>
          Promise.resolve({
            authenticator: softwareAuthenticator(),
            targeted: false,
          }),
      ],
      [
        'a revoked credential, with a right signature',
        'revoked',
        async ({ passkeyId }) => {
          await db()
            .update(passkeyCredential)
            .set({ revokedAt: T0 })
            .where(eq(passkeyCredential.id, passkeyId));
          return { targeted: true };
        },
      ],
      [
        'a disabled user, with a right signature',
        'disabled',
        async ({ userId }) => {
          await setUserStatus(database, userId, 'disabled');
          return { targeted: true };
        },
      ],
      [
        'a deleted user, with a right signature',
        'unknown-credential',
        async ({ userId }) => {
          await markUserDeleted(database, userId);
          return { targeted: false };
        },
      ],
      [
        'a wrong signature',
        'verification-failed',
        () =>
          Promise.resolve({ tweaks: { wrongSignature: true }, targeted: true }),
      ],
      [
        'another origin',
        'verification-failed',
        () =>
          Promise.resolve({
            tweaks: { origin: 'https://evil.example.test' },
            targeted: true,
          }),
      ],
      [
        'another relying party id',
        'verification-failed',
        () =>
          Promise.resolve({
            tweaks: { rpId: 'evil.example.test' },
            targeted: true,
          }),
      ],
      [
        'another challenge in the client data',
        'verification-failed',
        () =>
          Promise.resolve({
            tweaks: { challenge: 'bm90LXRoZS1jaGFsbGVuZ2U' },
            targeted: true,
          }),
      ],
      [
        'no user verification',
        'verification-failed',
        () =>
          Promise.resolve({ tweaks: { userVerified: false }, targeted: true }),
      ],
      [
        'a user handle that is not the credential owner’s',
        'verification-failed',
        () =>
          Promise.resolve({
            tweaks: { userHandle: 'bm90LXRoZS1oYW5kbGU' },
            targeted: true,
          }),
      ],
      [
        'a challenge nobody made',
        'challenge-invalid',
        () =>
          Promise.resolve({ challenge: () => generateToken(), targeted: true }),
      ],
      [
        'an overlong challenge',
        'challenge-invalid',
        () =>
          Promise.resolve({ challenge: () => 'x'.repeat(300), targeted: true }),
      ],
      [
        'a registration challenge',
        'challenge-invalid',
        ({ userId }) =>
          Promise.resolve({
            challenge: async () =>
              (
                await startPasskeyRegistration(db(), {
                  userId,
                  relyingParty: RP,
                  now: T0,
                })
              ).challenge,
            targeted: true,
          }),
      ],
    ];
    it.each(failureCases)(
      'answers one refusal for %s, and audits only a reason class, never a value',
      async (_name, reason, arrange) => {
        const { userId, authenticator, passkey } = await userWithPasskey();
        const arranged = await arrange({
          userId,
          passkeyId: passkey.id,
          authenticator,
        });
        const started = await startLogin();
        const challenge =
          arranged.challenge === undefined
            ? started.challenge
            : await arranged.challenge(started);
        const result = await signIn(
          started,
          arranged.authenticator ?? authenticator,
          {
            ...(arranged.tweaks === undefined
              ? {}
              : { tweaks: arranged.tweaks }),
            challenge,
          },
        );
        // The same value for every cause, and returned, not thrown.
        expect(result).toEqual({ ok: false });
        const failure = await lastFailure();
        expect(failure).toMatchObject({
          actorType: 'system',
          actorId: null,
          details: { method: 'passkey', reason },
        });
        expect(Object.keys(failure.details as object).sort()).toEqual([
          'method',
          'reason',
        ]);
        expect(failure.targetId).toBe(arranged.targeted ? userId : null);
        expect(failure.targetType).toBe(arranged.targeted ? 'user' : null);
        // No sign-in is recorded, and nothing is stored for the passkey.
        expect(
          (await events(AUTH_AUDIT.loginStepPassed)).filter(
            (event) => event.targetId === userId,
          ),
        ).toEqual([]);
        expect((await storedPasskey(passkey.id)).signCount).toBe(0);
        expect((await storedPasskey(passkey.id)).lastUsedAt).toBeNull();
      },
    );

    it('uses the challenge up on a refusal, so a right response to the same challenge is refused too', async () => {
      const { authenticator } = await userWithPasskey();
      const started = await startLogin();
      expect(
        await signIn(started, authenticator, {
          tweaks: { wrongSignature: true },
        }),
      ).toEqual({ ok: false });
      expect(await signIn(started, authenticator)).toEqual({ ok: false });
      expect((await lastFailure()).details).toEqual({
        method: 'passkey',
        reason: 'challenge-invalid',
      });
    });

    it('refuses a challenge that was already used, a replay of the same response, and one that has expired', async () => {
      const { authenticator } = await userWithPasskey();
      const started = await startLogin();
      const response = authenticator.authenticate(started.options);
      const finish = (challenge: string, now: Date) =>
        finishPasskeyLogin(db(), {
          relyingParty: RP,
          challenge,
          response,
          now,
        });
      expect((await finish(started.challenge, at(SECOND))).ok).toBe(true);
      expect(await finish(started.challenge, at(2 * SECOND))).toEqual({
        ok: false,
      });
      const ended = await startLogin(T0);
      expect(
        await signIn(ended, authenticator, { now: at(LOGIN_CHALLENGE.ttlMs) }),
      ).toEqual({ ok: false });
      expect((await lastFailure()).details).toEqual({
        method: 'passkey',
        reason: 'challenge-invalid',
      });
      const justInTime = await startLogin(T0);
      expect(
        (
          await signIn(justInTime, authenticator, {
            now: at(LOGIN_CHALLENGE.ttlMs - 1),
          })
        ).ok,
      ).toBe(true);
    });

    it('leaves a registration challenge untouched when it is presented to a sign-in, and the other way round', async () => {
      const { userId, authenticator } = await userWithPasskey();
      const registering = await start(userId, at(MINUTE));
      expect(
        await finishPasskeyLogin(db(), {
          relyingParty: RP,
          challenge: registering.challenge,
          response: authenticator.authenticate(registering.options),
          now: at(MINUTE),
        }),
      ).toEqual({ ok: false });
      expect((await challengeRow(registering.challenge))!.usedAt).toBeNull();
      const signingIn = await startLogin(at(MINUTE));
      expect(
        await finishPasskeyRegistration(db(), {
          userId,
          relyingParty: RP,
          challenge: signingIn.challenge,
          response: softwareAuthenticator().register(registering.options),
          now: at(MINUTE),
        }),
      ).toEqual({ ok: false });
      expect((await challengeRow(signingIn.challenge))!.usedAt).toBeNull();
    });

    it('lets only one of two requests through with one challenge, even with two right responses', async () => {
      const { authenticator } = await userWithPasskey();
      const started = await startLogin();
      const results = await Promise.all([
        signIn(started, authenticator),
        signIn(started, authenticator),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
    });

    it('never throttles the account, however many sign-ins with a passkey fail: no secret was guessed', async () => {
      const { userId, authenticator } = await userWithPasskey();
      for (let i = 0; i < 12; i += 1) {
        await signIn(await startLogin(), authenticator, {
          tweaks: { wrongSignature: true },
        });
      }
      expect(await isThrottled(db(), userId, at(SECOND))).toBe(false);
      expect((await signIn(await startLogin(), authenticator)).ok).toBe(true);
    });

    it('writes no credential id, key, signature or challenge into any event, failed or not', async () => {
      const { authenticator } = await userWithPasskey();
      const challenges: string[] = [];
      for (const tweaks of [{}, { wrongSignature: true }, { signCount: 0 }]) {
        const started = await startLogin();
        challenges.push(started.challenge);
        const response = authenticator.authenticate(started.options, tweaks);
        await finishPasskeyLogin(db(), {
          relyingParty: RP,
          challenge: started.challenge,
          response,
          now: at(SECOND),
        });
        challenges.push(
          response.response.signature,
          response.response.authenticatorData,
          response.response.clientDataJSON,
        );
      }
      const everything = JSON.stringify(await db().select().from(auditEvent));
      for (const secret of [
        ...challenges,
        ...challenges.map(hashToken),
        authenticator.credentialId,
        Buffer.from(authenticator.publicKey).toString('base64url'),
        Buffer.from(authenticator.publicKey).toString('hex'),
      ]) {
        expect(everything).not.toContain(secret);
      }
    });
  });

  describe('listPasskeys', () => {
    it('lists the live passkeys of the user in the order they were added, with no key material', async () => {
      const userId = await seedActiveUser(database);
      const first = await addPasskey(userId, {
        deviceName: 'Production office laptop',
        now: T0,
      });
      const second = await addPasskey(userId, { now: at(MINUTE) });
      const list = await listPasskeys(db(), userId);
      expect(list).toEqual([first.passkey, second.passkey]);
      for (const item of list) {
        expect(Object.keys(item).sort()).toEqual([
          'createdAt',
          'deviceName',
          'id',
          'lastUsedAt',
          'transports',
        ]);
      }
      const text = JSON.stringify(list);
      for (const material of [
        first.authenticator.credentialId,
        second.authenticator.credentialId,
        Buffer.from(first.authenticator.publicKey).toString('base64url'),
        Buffer.from(first.authenticator.publicKey).toString('hex'),
      ]) {
        expect(text).not.toContain(material);
      }
    });

    it('leaves out a revoked passkey and anyone else’s, and shows the time of the last sign-in', async () => {
      const userId = await seedActiveUser(database);
      const other = await seedActiveUser(database);
      const kept = await addPasskey(userId);
      const revoked = await addPasskey(userId);
      await addPasskey(other);
      await db()
        .update(passkeyCredential)
        .set({ revokedAt: T0 })
        .where(eq(passkeyCredential.id, revoked.passkey.id));
      const started = await startPasskeyLogin(db(), {
        relyingParty: RP,
        now: at(MINUTE),
      });
      await finishPasskeyLogin(db(), {
        relyingParty: RP,
        challenge: started.challenge,
        response: kept.authenticator.authenticate(started.options),
        now: at(MINUTE),
      });
      expect(await listPasskeys(db(), userId)).toEqual([
        { ...kept.passkey, lastUsedAt: at(MINUTE) },
      ]);
    });

    it('lists nothing for a user with no passkey, and for an id no one has', async () => {
      const userId = await seedActiveUser(database);
      expect(await listPasskeys(db(), userId)).toEqual([]);
      expect(await listPasskeys(db(), newId())).toEqual([]);
    });
  });

  describe('renamePasskey', () => {
    const rename = (
      userId: string,
      passkeyId: string,
      deviceName: string,
      now = at(MINUTE),
    ) => renamePasskey(db(), { userId, passkeyId, deviceName, now });

    it('renames the passkey, returns it, and audits the change without the name', async () => {
      const userId = await seedActiveUser(database);
      const { passkey } = await addPasskey(userId, { deviceName: 'Old name' });
      const renamed = await rename(
        userId,
        passkey.id,
        '  Camera trailer tablet  ',
      );
      expect(renamed).toEqual({
        ...passkey,
        deviceName: 'Camera trailer tablet',
      });
      expect((await listPasskeys(db(), userId))[0]!.deviceName).toBe(
        'Camera trailer tablet',
      );
      const [row] = await db()
        .select()
        .from(passkeyCredential)
        .where(eq(passkeyCredential.id, passkey.id));
      expect(row).toMatchObject({
        version: 2,
        updatedAt: at(MINUTE),
        updatedBy: userId,
      });
      const found = (await events(AUTH_AUDIT.passkeyRenamed)).filter(
        (event) => event.targetId === passkey.id,
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        action: 'rename',
        actorType: 'user',
        actorId: userId,
        targetType: 'passkey_credential',
        organisationId: null,
      });
      expect(JSON.stringify(found[0])).not.toContain('Camera trailer tablet');
      expect(JSON.stringify(found[0])).not.toContain('Old name');
    });

    it('gives one answer, null, for another user’s passkey, one that is not there and a revoked one, and changes nothing', async () => {
      const userId = await seedActiveUser(database);
      const other = await seedActiveUser(database);
      const mine = await addPasskey(userId, { deviceName: 'Mine' });
      const theirs = await addPasskey(other, { deviceName: 'Theirs' });
      const revoked = await addPasskey(userId, { deviceName: 'Revoked' });
      await db()
        .update(passkeyCredential)
        .set({ revokedAt: T0 })
        .where(eq(passkeyCredential.id, revoked.passkey.id));
      const before = await countRows();
      expect(await rename(userId, theirs.passkey.id, 'Taken')).toBeNull();
      expect(await rename(userId, newId(), 'Nothing')).toBeNull();
      expect(await rename(userId, revoked.passkey.id, 'Back')).toBeNull();
      expect(await countRows()).toEqual(before);
      expect((await listPasskeys(db(), other))[0]!.deviceName).toBe('Theirs');
      expect((await listPasskeys(db(), userId))[0]!.deviceName).toBe('Mine');
      expect(mine.passkey.id).not.toBe(theirs.passkey.id);
    });

    it('refuses a name that is blank, too long, or holds a control character, and changes nothing', async () => {
      const userId = await seedActiveUser(database);
      const { passkey } = await addPasskey(userId, { deviceName: 'Kept' });
      const before = await countRows();
      for (const name of [
        '',
        '   ',
        'x'.repeat(PASSKEY_SETTINGS.maxDeviceNameLength + 1),
        `tab${String.fromCodePoint(9)}name`,
      ]) {
        await expect(rename(userId, passkey.id, name)).rejects.toBeInstanceOf(
          AuthInputError,
        );
      }
      expect(await countRows()).toEqual(before);
      expect((await listPasskeys(db(), userId))[0]!.deviceName).toBe('Kept');
      // The longest name is fine.
      const longest = 'x'.repeat(PASSKEY_SETTINGS.maxDeviceNameLength);
      expect((await rename(userId, passkey.id, longest))!.deviceName).toBe(
        longest,
      );
    });
  });

  describe('revokePasskey', () => {
    const revoke = (userId: string, passkeyId: string, now = at(MINUTE)) =>
      revokePasskey(db(), { userId, passkeyId, now });
    const PASSWORD = 'cobblestone-heron-velvet-tide';

    /** A user with a password and one passkey. */
    async function userWithPasswordAndPasskey() {
      const userId = await seedActiveUser(database);
      await seedPassword(database, userId, PASSWORD);
      return { userId, ...(await addPasskey(userId)) };
    }

    it('revokes the passkey: it is no longer listed, no sign-in with it works, and the change is audited', async () => {
      const { userId, authenticator, passkey } =
        await userWithPasswordAndPasskey();
      expect(await revoke(userId, passkey.id)).toBe(true);
      expect(await listPasskeys(db(), userId)).toEqual([]);
      const [row] = await db()
        .select()
        .from(passkeyCredential)
        .where(eq(passkeyCredential.id, passkey.id));
      // Kept, marked, not deleted: the credential id stays taken.
      expect(row).toMatchObject({
        revokedAt: at(MINUTE),
        version: 2,
        updatedAt: at(MINUTE),
        updatedBy: userId,
      });
      const found = (await events(AUTH_AUDIT.passkeyRevoked)).filter(
        (event) => event.targetId === passkey.id,
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        action: 'revoke',
        actorType: 'user',
        actorId: userId,
        targetType: 'passkey_credential',
        organisationId: null,
      });
      expect(JSON.stringify(found[0])).not.toContain(
        authenticator.credentialId,
      );
      // And the passkey no longer signs anyone in.
      const started = await startPasskeyLogin(db(), {
        relyingParty: RP,
        now: at(2 * MINUTE),
      });
      expect(
        await finishPasskeyLogin(db(), {
          relyingParty: RP,
          challenge: started.challenge,
          response: authenticator.authenticate(started.options),
          now: at(2 * MINUTE),
        }),
      ).toEqual({ ok: false });
    });

    describe('the sessions it opened', () => {
      const sessionRowOf = async (id: string) =>
        (await db().select().from(session)).find((row) => row.id === id)!;
      const sessionsRevokedFor = async (userId: string) =>
        (await events(AUTH_AUDIT.sessionsRevoked)).filter(
          (event) =>
            event.targetId === userId &&
            (event.details as { reason?: string }).reason === 'passkey-revoked',
        );
      const openBy = (
        userId: string,
        method: 'passkey' | 'password',
        passkeyCredentialId?: string,
      ) =>
        createSession(db(), {
          userId,
          method,
          ...(passkeyCredentialId === undefined ? {} : { passkeyCredentialId }),
          now: T0,
        });

      it('are ended with it, with the reason, and every other session stays', async () => {
        const { userId, passkey } = await userWithPasswordAndPasskey();
        const second = await addPasskey(userId);
        const stranger = await userWithPasswordAndPasskey();
        const opened = [
          await openBy(userId, 'passkey', passkey.id),
          await openBy(userId, 'passkey', passkey.id),
        ];
        const kept = [
          await openBy(userId, 'password'),
          await openBy(userId, 'passkey', second.passkey.id),
          await openBy(stranger.userId, 'passkey', stranger.passkey.id),
        ];
        expect(await revoke(userId, passkey.id)).toBe(true);
        for (const { session: one } of opened) {
          expect(await sessionRowOf(one.id)).toMatchObject({
            revokedAt: at(MINUTE),
            revokedReason: 'passkey-revoked',
          });
        }
        for (const { session: one } of kept) {
          expect((await sessionRowOf(one.id)).revokedAt).toBeNull();
        }
        const found = await sessionsRevokedFor(userId);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
          actorId: userId,
          details: {
            reason: 'passkey-revoked',
            count: 2,
            passkeyId: passkey.id,
          },
        });
        // The same transaction wrote the revocation of the passkey itself.
        expect(
          (await events(AUTH_AUDIT.passkeyRevoked)).filter(
            (event) => event.targetId === passkey.id,
          ),
        ).toHaveLength(1);
      });

      it('writes no session event when it opened none', async () => {
        const { userId, passkey } = await userWithPasswordAndPasskey();
        expect(await revoke(userId, passkey.id)).toBe(true);
        expect(await sessionsRevokedFor(userId)).toEqual([]);
      });

      it('stay when the revocation is refused: the last way to sign in is not given up', async () => {
        const userId = await seedActiveUser(database);
        const { passkey } = await addPasskey(userId);
        const opened = await openBy(userId, 'passkey', passkey.id);
        await expect(revoke(userId, passkey.id)).rejects.toMatchObject({
          reason: 'last-sign-in-method',
        });
        expect((await sessionRowOf(opened.session.id)).revokedAt).toBeNull();
        expect(await sessionsRevokedFor(userId)).toEqual([]);
      });
    });

    it('gives one answer, false, for another user’s passkey, one that is not there and one already revoked, and changes nothing', async () => {
      const { userId, passkey } = await userWithPasswordAndPasskey();
      const other = await userWithPasswordAndPasskey();
      expect(await revoke(userId, other.passkey.id)).toBe(false);
      expect(await revoke(userId, newId())).toBe(false);
      expect((await listPasskeys(db(), other.userId)).length).toBe(1);
      expect(await revoke(userId, passkey.id)).toBe(true);
      const before = await countRows();
      expect(await revoke(userId, passkey.id)).toBe(false);
      expect(await countRows()).toEqual(before);
    });

    it('refuses the last way to sign in: no password and no other passkey, changing and writing nothing', async () => {
      const userId = await seedActiveUser(database);
      const { passkey } = await addPasskey(userId);
      const before = await countRows();
      await expect(revoke(userId, passkey.id)).rejects.toMatchObject({
        reason: 'last-sign-in-method',
      });
      await expect(revoke(userId, passkey.id)).rejects.toBeInstanceOf(
        AuthStateError,
      );
      expect(await countRows()).toEqual(before);
      expect(await listPasskeys(db(), userId)).toHaveLength(1);
    });

    it('allows it when another live passkey is left, and then refuses the last one', async () => {
      const userId = await seedActiveUser(database);
      const first = await addPasskey(userId);
      const second = await addPasskey(userId);
      expect(await revoke(userId, first.passkey.id)).toBe(true);
      await expect(revoke(userId, second.passkey.id)).rejects.toMatchObject({
        reason: 'last-sign-in-method',
      });
    });

    it('does not count a revoked passkey, or another user’s password, as a way to sign in', async () => {
      const userId = await seedActiveUser(database);
      const other = await seedActiveUser(database);
      await seedPassword(database, other, PASSWORD);
      const gone = await addPasskey(userId);
      const last = await addPasskey(userId);
      await db()
        .update(passkeyCredential)
        .set({ revokedAt: T0 })
        .where(eq(passkeyCredential.id, gone.passkey.id));
      await expect(revoke(userId, last.passkey.id)).rejects.toMatchObject({
        reason: 'last-sign-in-method',
      });
    });

    it('lets only one of two revocations at once through when they are the last two passkeys', async () => {
      const userId = await seedActiveUser(database);
      const first = await addPasskey(userId);
      const second = await addPasskey(userId);
      const outcomes = await Promise.allSettled([
        revoke(userId, first.passkey.id),
        revoke(userId, second.passkey.id),
      ]);
      expect(outcomes.filter((one) => one.status === 'fulfilled')).toHaveLength(
        1,
      );
      expect(outcomes.filter((one) => one.status === 'rejected')).toHaveLength(
        1,
      );
      expect(await listPasskeys(db(), userId)).toHaveLength(1);
    });

    it('refuses an unknown or deleted user', async () => {
      const deleted = await seedActiveUser(database);
      const { passkey } = await addPasskey(deleted);
      await markUserDeleted(database, deleted);
      await expect(revoke(deleted, passkey.id)).rejects.toMatchObject({
        reason: 'user-not-found',
      });
      await expect(revoke(newId(), newId())).rejects.toMatchObject({
        reason: 'user-not-found',
      });
    });
  });
});
