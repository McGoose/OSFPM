import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { COSEALG } from '@simplewebauthn/server/helpers';
import {
  passkeyCredential,
  passwordCredential,
  user,
  type SessionScope,
  type UserStatus,
} from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { AuthInputError, AuthStateError } from './errors.js';
import {
  createPasskeyChallenge,
  usePasskeyChallenge,
} from './login-challenge.js';
import {
  promoteSession,
  SESSION_USER_COLUMNS,
  type SessionUser,
} from './sessions.js';
import {
  AUTH_AUDIT,
  guardedAuth,
  isOneOf,
  lockUser,
  recordAuthAudit,
  serverId,
} from './shared.js';
import { recordLoginFailure, type LoginFailureReason } from './throttle.js';

/**
 * Passkeys (WebAuthn, FIDO2), the passwordless way to sign in (SC-10, decision
 * D-56). A signed-in user registers a passkey on a device, and later signs in
 * with it without giving an address or a password. The cryptography, the
 * checks of the origin, the relying party, the challenge and the signature, and
 * the CBOR and COSE formats are the job of `@simplewebauthn/server`: nothing
 * here parses or verifies WebAuthn by hand. What is here is the policy around
 * it: which options to ask for, what to store, and when to refuse.
 *
 * `passkey_credential` is a security table: written here, directly, and every
 * change is audited instead of change-logged (CLAUDE.md, Data rules). A
 * credential's public key is not a secret, but nothing here writes it, the
 * credential id or a challenge into a log, an audit event or an error: the
 * library's own error messages quote the challenge, so they are caught and
 * dropped, never passed on (CLAUDE.md, Privacy rule). These functions check no
 * permission: the route that calls them has already decided who may. Pass the
 * transaction handle, and the time as `now`.
 */

/**
 * The settings every passkey step uses, in one place. `relyingPartyName` is the
 * name a person sees in the browser's prompt. `algorithms` are the COSE
 * algorithms accepted for a new key: ES256 and RS256, which every authenticator
 * supports. `maxDeviceNameLength` bounds the name a person gives a passkey.
 */
export const PASSKEY_SETTINGS = {
  relyingPartyName: 'OSFPM',
  algorithms: [COSEALG.ES256, COSEALG.RS256],
  maxDeviceNameLength: 100,
} as const;

/**
 * The site a passkey belongs to. `id` is the host name of the public URL, which
 * the authenticator ties each passkey to: a passkey made for one id is of no use
 * on another, so changing the host of `OSFPM_PUBLIC_URL` makes every existing
 * passkey unusable. `origin` is the only origin a ceremony may happen on.
 */
export type RelyingParty = {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
};

/**
 * The relying party for a public URL (`OSFPM_PUBLIC_URL`): the id is its host
 * name, the origin is its origin, and the name is `PASSKEY_SETTINGS.relyingPartyName`.
 * The path, the query and a default port are not part of either. Anyone may call
 * it; it reads no database.
 *
 * @throws TypeError when `publicOrigin` is not a URL. The API checks it at
 * start-up, so this does not happen for a configured server.
 */
export function relyingPartyFor(publicOrigin: string): RelyingParty {
  const url = new URL(publicOrigin);
  return {
    id: url.hostname,
    name: PASSKEY_SETTINGS.relyingPartyName,
    origin: url.origin,
  };
}

/**
 * A passkey as the services return it: what a person needs to tell their
 * passkeys apart. Never the credential id, the public key or the sign count.
 */
export type PasskeySummary = {
  readonly id: string;
  /** The name the person gave it, such as "Production office laptop". */
  readonly deviceName: string | null;
  readonly createdAt: Date;
  /** The last sign-in with it, or `null` if it was never used. */
  readonly lastUsedAt: Date | null;
  /** How the browser says it is reached: `internal`, `usb`, `hybrid` and so on. */
  readonly transports: string[];
};

/** The columns of a `PasskeySummary`, one list so the type and what is selected cannot drift apart. */
const summaryColumns = {
  id: passkeyCredential.id,
  deviceName: passkeyCredential.deviceName,
  createdAt: passkeyCredential.createdAt,
  lastUsedAt: passkeyCredential.lastUsedAt,
  transports: passkeyCredential.transports,
};

/**
 * The transports a browser may report for a passkey (WebAuthn, section 5.8.4).
 * What a client sends is kept only if it is on this list, so no free text is
 * stored. They are only hints to a browser about how to reach the key.
 */
const KNOWN_TRANSPORTS = [
  'ble',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
] as const;

/** At most this many reported transports are looked at: there are six kinds. */
const MAX_TRANSPORTS_READ = 16;

/** The transports on `KNOWN_TRANSPORTS` in `value`, once each, in the order they were reported. */
function knownTransports(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const kept = new Set<string>();
  for (const item of value.slice(0, MAX_TRANSPORTS_READ) as unknown[]) {
    if (isOneOf(KNOWN_TRANSPORTS, item)) kept.add(item);
  }
  return [...kept];
}

/** Anything that is a control character: a line break or a bell in a name that is shown in a list. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * The name of a passkey as it is stored: trimmed, and `null` when none was given
 * or it is blank. A name that is too long, holds a control character or is not
 * text is refused.
 *
 * @throws AuthInputError `deviceName`.
 */
function normaliseDeviceName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new AuthInputError('deviceName');
  const name = value.trim();
  if (name === '') return null;
  if (
    name.length > PASSKEY_SETTINGS.maxDeviceNameLength ||
    CONTROL_CHARACTER.test(name)
  ) {
    throw new AuthInputError('deviceName');
  }
  return name;
}

/**
 * The user handle an authenticator keeps for a user: the 16 bytes of the user's
 * id. It is an opaque identifier and holds no personal detail. Registering on an
 * authenticator that already has a passkey for the same handle and site replaces
 * it, which is why the options exclude the user's live passkeys.
 */
function userHandleOf(userId: string): Uint8Array<ArrayBuffer> {
  return Buffer.from(userId.replaceAll('-', ''), 'hex');
}

/** What `startPasskeyRegistration` returns. */
export type PasskeyRegistrationStart = {
  /**
   * The challenge, shown to the client once: the id to send back with the
   * response, and the value the authenticator signs (`options.challenge` is the
   * same string). Only its hash is stored.
   */
  readonly challenge: string;
  /** What the browser passes to `navigator.credentials.create()`. */
  readonly options: PublicKeyCredentialCreationOptionsJSON;
  /** When the challenge stops working. */
  readonly expiresAt: Date;
};

/**
 * Starts adding a passkey for a signed-in user: makes a challenge that ends in
 * five minutes (`LOGIN_CHALLENGE`) and the options for the browser. The options
 * ask for a discoverable credential (`residentKey: 'required'`, so a later
 * sign-in needs no address), for the device to verify the person with a PIN,
 * fingerprint or face (`userVerification: 'required'`), for no attestation, for
 * ES256 or RS256 keys (`PASSKEY_SETTINGS`), and exclude the user's live passkeys,
 * so one device is not registered twice. A revoked passkey is not excluded.
 * Audited as `auth.passkey-registration-started`, never with the challenge.
 *
 * The user row is locked, so a disable that runs at the same moment either
 * finishes first (this is refused) or waits. The user's expired challenges are
 * deleted first.
 *
 * @throws AuthStateError `user-not-found` for an unknown or deleted user,
 * `user-disabled` for a disabled one, `installation-missing` before the
 * installation row exists.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export function startPasskeyRegistration(
  tx: Tx,
  input: { userId: string; relyingParty: RelyingParty; now: Date },
): Promise<PasskeyRegistrationStart> {
  const { userId, relyingParty, now } = input;
  return guardedAuth('login_challenge', 'insert', () =>
    // A savepoint: a refusal leaves no challenge and no event.
    tx.transaction(async (inner) => {
      const locked = await lockUser(inner, userId);
      if (locked.status === 'disabled') {
        throw new AuthStateError('user-disabled');
      }
      const [owner] = await inner
        .select({ email: user.email, displayName: user.displayName })
        .from(user)
        .where(eq(user.id, userId));
      const live = await inner
        .select({
          credentialId: passkeyCredential.credentialId,
          transports: passkeyCredential.transports,
        })
        .from(passkeyCredential)
        .where(
          and(
            eq(passkeyCredential.userId, userId),
            isNull(passkeyCredential.revokedAt),
          ),
        )
        .orderBy(asc(passkeyCredential.createdAt), asc(passkeyCredential.id));

      const { token, expiresAt } = await createPasskeyChallenge(inner, {
        kind: 'webauthn-register',
        userId,
        now,
      });
      const options = await generateRegistrationOptions({
        rpName: relyingParty.name,
        rpID: relyingParty.id,
        userName: owner!.email,
        userDisplayName: owner!.displayName,
        userID: userHandleOf(userId),
        // The token's own bytes, so `options.challenge` is the token.
        challenge: Buffer.from(token, 'base64url'),
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
        excludeCredentials: live.map((credential) => ({
          id: credential.credentialId,
          transports: credential.transports,
        })),
        supportedAlgorithmIDs: [...PASSKEY_SETTINGS.algorithms],
      });
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.passkeyRegistrationStarted,
        action: 'start',
        actor: { type: 'user', id: userId },
        targetType: 'user',
        targetId: userId,
        occurredAt: now,
      });
      return { challenge: token, options, expiresAt };
    }),
  );
}

/** The answer of `finishPasskeyRegistration`. A refusal is one value whatever the cause. */
export type FinishPasskeyRegistrationResult =
  | { readonly ok: true; readonly passkey: PasskeySummary }
  | { readonly ok: false };

/**
 * Finishes adding a passkey: checks the challenge and the browser's response,
 * and stores the credential (its id, its public key, its sign count, its
 * transports and, if one was given, its name). Returns `{ ok: false }`, writing
 * no passkey, for every refusal: a challenge that is unknown, used, expired, of
 * another kind or another user, a response whose origin, relying party,
 * challenge or key type is wrong, one without user presence or user
 * verification, and a credential id that is already registered, whoever has it.
 * The library's messages are dropped: they quote the challenge.
 *
 * A challenge is used up by the first response that reaches the check, right or
 * wrong, and the refusal is returned, not thrown, so the caller's transaction
 * commits and it stays used. A challenge of another user or kind is not touched.
 * A user's refused attempt is not audited: nothing secret was guessed. A passkey
 * added is audited as `auth.passkey-registered`, with the passkey as its target
 * and never its credential id or key.
 *
 * `session` is the session making the change. A `recovery` session becomes
 * `full` (SC-10): the user has set a new way to sign in. Other sessions stay: a
 * passkey adds a way in, it does not remove one.
 *
 * @throws AuthInputError `deviceName` when the name is too long, holds a control
 * character or is not text. Nothing is touched.
 * @throws AuthStateError `user-not-found` for an unknown or deleted user,
 * `user-disabled` for a disabled one, `installation-missing` before the
 * installation row exists.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export async function finishPasskeyRegistration(
  tx: Tx,
  input: {
    userId: string;
    relyingParty: RelyingParty;
    /** The challenge `startPasskeyRegistration` returned. */
    challenge: string;
    /** What the browser's `navigator.credentials.create()` returned, as JSON. */
    response: RegistrationResponseJSON;
    deviceName?: string | null;
    /** The session making the change: made full if it is a recovery one. */
    session?: { id: string; scope: SessionScope };
    now: Date;
  },
): Promise<FinishPasskeyRegistrationResult> {
  const { userId, relyingParty, now } = input;
  const deviceName = normaliseDeviceName(input.deviceName);
  return guardedAuth('passkey_credential', 'insert', () =>
    tx.transaction(async (inner): Promise<FinishPasskeyRegistrationResult> => {
      const locked = await lockUser(inner, userId);
      if (locked.status === 'disabled') {
        throw new AuthStateError('user-disabled');
      }
      const live = await usePasskeyChallenge(inner, {
        token: input.challenge,
        kind: 'webauthn-register',
        userId,
        now,
      });
      if (!live) return { ok: false };

      let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verified = await verifyRegistrationResponse({
          response: input.response,
          expectedChallenge: input.challenge,
          expectedOrigin: relyingParty.origin,
          expectedRPID: relyingParty.id,
          requireUserPresence: true,
          requireUserVerification: true,
          supportedAlgorithmIDs: [...PASSKEY_SETTINGS.algorithms],
        });
      } catch {
        // The library throws for most refusals and quotes the challenge in what
        // it says: only the fact of the refusal is kept.
        return { ok: false };
      }
      if (!verified.verified) return { ok: false };
      const { credential } = verified.registrationInfo;

      // A credential id is unique across the installation, revoked ones too. An
      // authenticator that ignores `excludeCredentials`, or a client that
      // chooses the id, would otherwise reach the unique constraint.
      const [taken] = await inner
        .select({ id: passkeyCredential.id })
        .from(passkeyCredential)
        .where(eq(passkeyCredential.credentialId, credential.id))
        .limit(1);
      if (taken !== undefined) return { ok: false };

      const [passkey] = await inner
        .insert(passkeyCredential)
        .values({
          originServer: await serverId(inner),
          userId,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          signCount: credential.counter,
          transports: knownTransports(credential.transports),
          deviceName,
          createdAt: now,
          updatedAt: now,
          createdBy: userId,
          updatedBy: userId,
        })
        .returning(summaryColumns);
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.passkeyRegistered,
        action: 'register',
        actor: { type: 'user', id: userId },
        targetType: 'passkey_credential',
        targetId: passkey!.id,
        occurredAt: now,
      });
      if (input.session?.scope === 'recovery') {
        await promoteSession(inner, input.session.id, {
          trigger: 'passkey-registered',
          now,
        });
      }
      return { ok: true, passkey: passkey! };
    }),
  );
}

/** What `startPasskeyLogin` returns. */
export type PasskeyLoginStart = {
  /**
   * The challenge, shown to the client once: the id to send back with the
   * response, and the value the authenticator signs (`options.challenge` is the
   * same string). Only its hash is stored.
   */
  readonly challenge: string;
  /** What the browser passes to `navigator.credentials.get()`. */
  readonly options: PublicKeyCredentialRequestOptionsJSON;
  /** When the challenge stops working. */
  readonly expiresAt: Date;
};

/**
 * Starts a sign-in with a passkey, for a person who has given no address: makes
 * a challenge that ends in five minutes (`LOGIN_CHALLENGE`), tied to no one, and
 * the options for the browser. The options name no credential
 * (`allowCredentials` is left out), so the device offers the passkeys it has for
 * this site, and a caller cannot use them to find out which credential ids
 * exist. They ask for user verification (`userVerification: 'required'`). It
 * writes no audit event: nobody has signed in or failed yet, and anyone may ask
 * for options (the route limits how often). Anyone may call it.
 *
 * @throws AuthStateError `installation-missing` before the installation row
 * exists.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export function startPasskeyLogin(
  tx: Tx,
  input: { relyingParty: RelyingParty; now: Date },
): Promise<PasskeyLoginStart> {
  const { relyingParty, now } = input;
  return guardedAuth('login_challenge', 'insert', () =>
    tx.transaction(async (inner) => {
      const { token, expiresAt } = await createPasskeyChallenge(inner, {
        kind: 'webauthn-login',
        userId: null,
        now,
      });
      const options = await generateAuthenticationOptions({
        rpID: relyingParty.id,
        challenge: Buffer.from(token, 'base64url'),
        userVerification: 'required',
      });
      return { challenge: token, options, expiresAt };
    }),
  );
}

/**
 * The answer of `finishPasskeyLogin`. A failure is one value whatever the cause;
 * the reason is for the audit trail alone.
 */
export type PasskeyLoginResult =
  { readonly ok: true; readonly user: SessionUser } | { readonly ok: false };

/** A credential id is at most 1023 bytes (WebAuthn, section 4), which is 1364 characters in base64url. */
const MAX_CREDENTIAL_ID_LENGTH = 1400;

/** The credential id a response claims, if it is shaped like one. It is only a key to look the credential up by. */
function claimedCredentialId(response: unknown): string | null {
  const id = (response as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_CREDENTIAL_ID_LENGTH
    ? id
    : null;
}

/**
 * Finishes a sign-in with a passkey: takes the challenge `startPasskeyLogin`
 * made and the browser's response, finds the credential by its id, and returns
 * the user it belongs to when everything is right. Creating the session is the
 * caller's next move.
 *
 * Returns `{ ok: false }` for every other case, one value for all: a challenge
 * that is unknown, used, expired or of another kind; a credential the server
 * does not have; a revoked credential; a disabled or deleted user; a response
 * whose signature, origin, relying party or challenge is wrong or that has no
 * user verification; and a signature counter that did not go up. Each is audited
 * as `auth.login-step-failed` with the method `passkey` and one reason class
 * (`unknown-credential`, `revoked`, `disabled`, `verification-failed`,
 * `counter-regressed` or `challenge-invalid`), never a value that was sent: no
 * credential id, key, signature or challenge. Its target is the user only when
 * the server found them from the credential. A success is audited as
 * `auth.login-step-passed`. The refusal is returned, not thrown, so the caller's
 * transaction commits and the event is kept. The library's messages are dropped:
 * they quote the challenge.
 *
 * The challenge is used up by the first response that reaches it, right or
 * wrong, so a replay, or a second try with the same challenge, is refused. The
 * user row is locked while the response is judged, before the challenge, as in
 * every other step, so two requests at once cannot both pass.
 *
 * The signature counter follows the WebAuthn rule (section 7.2): when either the
 * stored count or the new one is above 0, the new one must be higher, or the
 * credential may have been cloned, and the sign-in is refused as
 * `counter-regressed` and the stored count kept. A device that never counts, and
 * so always reports 0, is accepted. On a success the new count and the time are
 * stored. The library's own counter check is switched off by giving it a count
 * of 0, because the rule lives here, where it has its own audit reason.
 *
 * The account is found from the credential id, which maps only to its owner; the
 * `userHandle` in the response is not used to find it. A failure never counts
 * toward the account's throttle: a passkey is not a secret anyone guesses. It
 * does not spend the time of one derivation to hide which cause it was, as the
 * password step does.
 *
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export function finishPasskeyLogin(
  tx: Tx,
  input: {
    relyingParty: RelyingParty;
    /** The challenge `startPasskeyLogin` returned. */
    challenge: string;
    /** What the browser's `navigator.credentials.get()` returned, as JSON. */
    response: AuthenticationResponseJSON;
    now: Date;
  },
): Promise<PasskeyLoginResult> {
  const { relyingParty, now } = input;
  const credentialId = claimedCredentialId(input.response);
  return guardedAuth('passkey_credential', 'update', () =>
    tx.transaction(async (inner): Promise<PasskeyLoginResult> => {
      const refuse = async (
        userId: string | null,
        reason: LoginFailureReason,
      ): Promise<PasskeyLoginResult> => {
        await recordLoginFailure(inner, {
          method: 'passkey',
          reason,
          userId,
          now,
        });
        return { ok: false };
      };

      // Whose credential is it, if anyone's? Read first only to know whose row to
      // lock first (the user, then the challenge, as every other step does), and
      // read again below under the lock.
      const [owner] =
        credentialId === null
          ? []
          : await inner
              .select({ userId: passkeyCredential.userId })
              .from(passkeyCredential)
              .where(eq(passkeyCredential.credentialId, credentialId))
              .limit(1);
      let status: UserStatus | undefined;
      if (owner !== undefined) {
        try {
          status = (await lockUser(inner, owner.userId)).status;
        } catch (error) {
          // Deleted since: as if the credential were not known.
          if (!(error instanceof AuthStateError)) throw error;
        }
      }
      const knownUser = status === undefined ? null : owner!.userId;

      // The challenge is judged first, so one that ran out says so in the audit
      // trail, and is used up by any attempt that gets past this point.
      const live = await usePasskeyChallenge(inner, {
        token: input.challenge,
        kind: 'webauthn-login',
        userId: null,
        now,
      });
      if (!live) return refuse(knownUser, 'challenge-invalid');
      if (credentialId === null || knownUser === null) {
        return refuse(null, 'unknown-credential');
      }

      const [row] = await inner
        .select({
          id: passkeyCredential.id,
          publicKey: passkeyCredential.publicKey,
          signCount: passkeyCredential.signCount,
          transports: passkeyCredential.transports,
          revokedAt: passkeyCredential.revokedAt,
        })
        .from(passkeyCredential)
        .where(eq(passkeyCredential.credentialId, credentialId))
        .limit(1);
      if (row === undefined) return refuse(null, 'unknown-credential');
      if (row.revokedAt !== null) return refuse(knownUser, 'revoked');
      if (status === 'disabled') return refuse(knownUser, 'disabled');

      let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try {
        verified = await verifyAuthenticationResponse({
          response: input.response,
          expectedChallenge: input.challenge,
          expectedOrigin: relyingParty.origin,
          expectedRPID: relyingParty.id,
          credential: {
            id: credentialId,
            publicKey: new Uint8Array(row.publicKey),
            // 0 switches off the library's own counter check: the rule is below.
            counter: 0,
            transports: row.transports,
          },
          requireUserVerification: true,
        });
      } catch {
        // The library throws for most refusals and quotes the challenge in what
        // it says: only the fact of the refusal is kept.
        return refuse(knownUser, 'verification-failed');
      }
      if (!verified.verified) return refuse(knownUser, 'verification-failed');

      const reported = verified.authenticationInfo.newCounter;
      if ((reported > 0 || row.signCount > 0) && reported <= row.signCount) {
        return refuse(knownUser, 'counter-regressed');
      }

      await inner
        .update(passkeyCredential)
        .set({ signCount: reported, lastUsedAt: now, updatedAt: now })
        .where(eq(passkeyCredential.id, row.id));
      const [signedIn] = await inner
        .select(SESSION_USER_COLUMNS)
        .from(user)
        .where(eq(user.id, knownUser));
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.loginStepPassed,
        action: 'pass',
        actor: { type: 'user', id: knownUser },
        targetType: 'user',
        targetId: knownUser,
        details: { method: 'passkey', next: 'session' },
        occurredAt: now,
      });
      return { ok: true, user: signedIn! };
    }),
  );
}

/**
 * Lists a user's live passkeys, in the order they were added: not revoked. For a
 * "my passkeys" screen; the caller has decided that the user may see them, and
 * that they are the user's own. Returns what a person needs to tell them apart
 * (`PasskeySummary`) and never a credential id, a public key or a sign count.
 *
 * @throws RecordWriteError when the database fails.
 */
export function listPasskeys(
  tx: Tx,
  userId: string,
): Promise<PasskeySummary[]> {
  return guardedAuth('passkey_credential', 'select', () =>
    tx
      .select(summaryColumns)
      .from(passkeyCredential)
      .where(
        and(
          eq(passkeyCredential.userId, userId),
          isNull(passkeyCredential.revokedAt),
        ),
      )
      .orderBy(asc(passkeyCredential.createdAt), asc(passkeyCredential.id)),
  );
}

/**
 * Renames one of a user's live passkeys. Returns it, or `null` when the user has
 * no live passkey with this id: the id is of someone else's passkey, of none, or
 * of a revoked one, with one answer for all, so a caller learns nothing about
 * which. The owner is checked here, in the same statement that writes, so no
 * caller has to look first. Audited as `auth.passkey-renamed` with the passkey as
 * its target and never the name, which is free text.
 *
 * @throws AuthInputError `deviceName` when the name is blank, too long, has a
 * control character or is not text. Nothing is written.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export async function renamePasskey(
  tx: Tx,
  input: { userId: string; passkeyId: string; deviceName: string; now: Date },
): Promise<PasskeySummary | null> {
  const { userId, passkeyId, now } = input;
  const deviceName = normaliseDeviceName(input.deviceName);
  // A rename to nothing is not a rename: a name is cleared by never giving one.
  if (deviceName === null) throw new AuthInputError('deviceName');
  return guardedAuth('passkey_credential', 'update', () =>
    tx.transaction(async (inner) => {
      const [renamed] = await inner
        .update(passkeyCredential)
        .set({
          deviceName,
          version: sql`${passkeyCredential.version} + 1`,
          updatedAt: now,
          updatedBy: userId,
        })
        .where(
          and(
            eq(passkeyCredential.id, passkeyId),
            eq(passkeyCredential.userId, userId),
            isNull(passkeyCredential.revokedAt),
          ),
        )
        .returning(summaryColumns);
      if (renamed === undefined) return null;
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.passkeyRenamed,
        action: 'rename',
        actor: { type: 'user', id: userId },
        targetType: 'passkey_credential',
        targetId: renamed.id,
        occurredAt: now,
      });
      return renamed;
    }),
  );
}

/**
 * Revokes one of a user's live passkeys: it is kept, marked revoked, and never
 * signs anyone in again. Returns true when it did, and false, writing nothing,
 * when the user has no live passkey with this id (someone else's, none, or one
 * already revoked), with one answer for all. The owner is checked here, so no
 * caller has to look first. Audited as `auth.passkey-revoked` with the passkey
 * as its target. It ends no session: a user ends those on their own.
 *
 * Every user keeps at least one way to sign in (SC-10, decision D-56): a user
 * who has no password and no other live passkey cannot revoke their last one, and
 * it is refused. The user row is locked, so two revocations at once of the last
 * two passkeys cannot both pass the check.
 *
 * @throws AuthStateError `last-sign-in-method` when this is the user's last way
 * to sign in, `user-not-found` for an unknown or deleted user. Nothing is
 * written.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export function revokePasskey(
  tx: Tx,
  input: { userId: string; passkeyId: string; now: Date },
): Promise<boolean> {
  const { userId, passkeyId, now } = input;
  return guardedAuth('passkey_credential', 'update', () =>
    // A savepoint: a refusal leaves the passkey and the trail as they were.
    tx.transaction(async (inner) => {
      await lockUser(inner, userId);
      const [target] = await inner
        .select({ id: passkeyCredential.id })
        .from(passkeyCredential)
        .where(
          and(
            eq(passkeyCredential.id, passkeyId),
            eq(passkeyCredential.userId, userId),
            isNull(passkeyCredential.revokedAt),
          ),
        )
        .limit(1);
      if (target === undefined) return false;

      const [another] = await inner
        .select({ id: passkeyCredential.id })
        .from(passkeyCredential)
        .where(
          and(
            eq(passkeyCredential.userId, userId),
            isNull(passkeyCredential.revokedAt),
            ne(passkeyCredential.id, passkeyId),
          ),
        )
        .limit(1);
      if (another === undefined) {
        const [password] = await inner
          .select({ id: passwordCredential.id })
          .from(passwordCredential)
          .where(eq(passwordCredential.userId, userId))
          .limit(1);
        if (password === undefined) {
          throw new AuthStateError('last-sign-in-method');
        }
      }

      await inner
        .update(passkeyCredential)
        .set({
          revokedAt: now,
          version: sql`${passkeyCredential.version} + 1`,
          updatedAt: now,
          updatedBy: userId,
        })
        .where(eq(passkeyCredential.id, passkeyId));
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.passkeyRevoked,
        action: 'revoke',
        actor: { type: 'user', id: userId },
        targetType: 'passkey_credential',
        targetId: passkeyId,
        occurredAt: now,
      });
      return true;
    }),
  );
}
