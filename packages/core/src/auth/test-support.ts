import {
  argon2Sync,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { PERMISSION_LISTS } from '../access/permission-lists.js';
import { syncPermissions } from '../access/permission-sync.js';
import { ORIGIN, seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  installation,
  passwordCredential,
  totpCredential,
  user,
} from '../db/schema/index.js';
import { ensureInstallation } from './ensure-installation.js';
import type { FirstRunSetupInput } from './first-run-setup.js';
import { hashPassword, PASSWORD_HASH_PARAMS } from './password.js';
import { normalisePassword } from './password-policy.js';
import { issueSetupCode } from './setup-code.js';

/**
 * Helpers for the auth tests. Fixtures insert straight into the tables, as the
 * other tests do (CLAUDE.md, Data rules); the code under test writes through
 * the auth service. Only tests import this file. People are invented.
 */

/** Adds the single `installation` row, which the auth services read for this server's id. */
export async function seedInstallation(database: Database): Promise<string> {
  const id = newId();
  await database.db
    .insert(installation)
    .values({ id, baseUrl: 'https://osfpm.example.test' });
  return id;
}

/**
 * Marks first-run setup complete directly, with no administrator, for a test that
 * is not about setup but needs the server open (`installation.setup_completed_at`
 * is what the setup gate reads). The installation row must exist.
 */
export async function markSetupComplete(
  database: Database,
  at: Date = new Date(),
): Promise<void> {
  await database.db.update(installation).set({ setupCompletedAt: at });
}

/** The invented address of the administrator a first-run test sets up. */
export const DEMO_ADMIN_EMAIL = 'ada.demo@demopictures.example';

/**
 * An invented password for that administrator. It holds no word of
 * `DEMO_ADMIN_EMAIL` and is not on the policy's list, so the policy accepts it.
 */
export const DEMO_ADMIN_PASSWORD = 'meadow-lantern-slow-river';

/**
 * What the setup screen sends for the fictional Demo Pictures, with `code`: an
 * administrator with `DEMO_ADMIN_PASSWORD` unless `password` is given, or is
 * `null` for none (so the session must be secured first).
 */
export function demoSetupInput(
  code: string,
  options: { password?: string | null; email?: string } = {},
): FirstRunSetupInput {
  const password =
    options.password === undefined ? DEMO_ADMIN_PASSWORD : options.password;
  return {
    code,
    organisation: {
      name: 'Demo Pictures',
      country: 'GB',
      baseCurrency: 'GBP',
      locale: 'en-GB',
      timeZone: 'Europe/London',
    },
    admin: {
      email: options.email ?? DEMO_ADMIN_EMAIL,
      displayName: 'Ada Demo',
      ...(password === null ? {} : { password }),
    },
  };
}

/**
 * Everything first-run setup needs: the installation row (made by the service
 * start-up uses), the permission catalogue (every list in `PERMISSION_LISTS`, as
 * start-up syncs them) and a live setup code, which it returns.
 */
export async function seedFirstRun(
  database: Database,
  now: Date = new Date(),
): Promise<string> {
  await ensureInstallation(database.db, {
    baseUrl: 'https://osfpm.example.test',
    now,
  });
  for (const list of PERMISSION_LISTS) {
    await syncPermissions(database.db, list);
  }
  return issueSetupCode(database.db, now);
}

/** An active user with an invented address. */
export const seedActiveUser = seedUser;

/**
 * An active user with the address given, which must already be normalised (lower
 * case). For a test that needs to know the address, such as one about an invite
 * that names it.
 */
export async function seedActiveUserWithEmail(
  database: Database,
  email: string,
): Promise<string> {
  const [created] = await database.db
    .insert(user)
    .values({
      originServer: ORIGIN,
      email,
      displayName: 'Fixture Person',
      locale: 'en-GB',
      timezone: 'Europe/London',
      status: 'active',
    })
    .returning();
  return created!.id;
}

/** A user in `status`, for the cases an active user does not cover. */
export async function seedUserWithStatus(
  database: Database,
  status: 'invited' | 'active' | 'disabled',
): Promise<string> {
  const id = await seedUser(database);
  await setUserStatus(database, id, status);
  return id;
}

/** Sets a user's status directly, bypassing the auth service. */
export async function setUserStatus(
  database: Database,
  userId: string,
  status: 'invited' | 'active' | 'disabled',
): Promise<void> {
  await database.db
    .update(user)
    .set({ status })
    .where(sql`${user.id} = ${userId}`);
}

type Row = Record<string, unknown>;

/** Runs a query and returns its rows, whichever driver is in use. */
export async function rowsOf(
  database: Database,
  query: ReturnType<typeof sql>,
): Promise<Row[]> {
  const result = (await database.db.execute(query)) as { rows: Row[] };
  return result.rows;
}

/**
 * Every row of every table in the database, as JSON text. Tests search it for a
 * raw token, code or password to show none was ever stored, in any table.
 */
export async function everyRowAsText(database: Database): Promise<string> {
  const tables = await rowsOf(
    database,
    sql`select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  const parts: string[] = [];
  for (const { table_name: name } of tables) {
    const found = await rowsOf(
      database,
      sql`select coalesce(string_agg(to_jsonb(t)::text, E'\n'), '') as text
          from ${sql.identifier(name as string)} t`,
    );
    parts.push(String(found[0]!.text));
  }
  return parts.join('\n');
}

/** The stored email address of a user. */
export async function emailOf(
  database: Database,
  userId: string,
): Promise<string> {
  const [row] = await database.db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId));
  return row!.email;
}

/** Hashes are slow on purpose, so each distinct password is hashed once per test run. */
const hashesByPassword = new Map<string, Promise<string>>();

/**
 * Gives a user a password: inserts the `password_credential` row directly, as
 * fixtures do. The password is normalised first, as the services do, and hashed
 * once per distinct password. `hash` stores that PHC string instead, for a test
 * that needs a hash made with other parameters (see `passwordHashWith`).
 * Invented passwords only.
 */
export async function seedPassword(
  database: Database,
  userId: string,
  password: string,
  options: { mustChange?: boolean; now?: Date; hash?: string } = {},
): Promise<void> {
  const normalised = normalisePassword(password);
  let hash = hashesByPassword.get(normalised);
  if (hash === undefined) {
    hash = hashPassword(normalised);
    hashesByPassword.set(normalised, hash);
  }
  await database.db.insert(passwordCredential).values({
    originServer: ORIGIN,
    userId,
    hash: options.hash ?? (await hash),
    changedAt: options.now ?? new Date(),
    mustChange: options.mustChange ?? false,
  });
}

/**
 * Gives a user an authenticator-app secret, confirmed unless `confirmed` is
 * false, and returns the secret in base32 so a test can make codes with
 * `totpCodeAt`.
 */
export async function seedTotp(
  database: Database,
  userId: string,
  options: { confirmed?: boolean; now?: Date } = {},
): Promise<string> {
  const secret = new Secret({ size: 20 }).base32;
  await database.db.insert(totpCredential).values({
    originServer: ORIGIN,
    userId,
    secret,
    confirmedAt:
      options.confirmed === false ? null : (options.now ?? new Date()),
  });
  return secret;
}

/** The authenticator code for `secret` at `time`, as an app would show it. */
export function totpCodeAt(secret: string, time: Date): string {
  return TOTP.generate({
    secret: Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    timestamp: time.getTime(),
  });
}

/** Marks a user deleted directly, bypassing the services, for the cases an active user does not cover. */
export async function markUserDeleted(
  database: Database,
  userId: string,
  at: Date = new Date(),
): Promise<void> {
  await database.db
    .update(user)
    .set({ deletedAt: at })
    .where(eq(user.id, userId));
}

/** What the CBOR helper of the WebAuthn library encodes. */
type Cbor = Parameters<typeof isoCBOR.encode>[0];

/** The authenticator-data flags the software authenticator sets (WebAuthn, section 6.1). */
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;

/**
 * The key types the software authenticator can make. ES256 and RS256 are the two
 * the server accepts; EdDSA is one it does not, for the test that refuses it.
 */
export type SoftwareKeyAlgorithm = 'ES256' | 'RS256' | 'EdDSA';

/**
 * What a test may change about one response to make a server refuse it. Each
 * leaves everything else as a real authenticator and browser would send it.
 */
export type ResponseTweaks = {
  /** The origin written into the client data, in place of the authenticator's own. */
  readonly origin?: string;
  /** The relying party id hashed into the authenticator data, in place of the one in the options. */
  readonly rpId?: string;
  /** The challenge written into the client data, in place of the one in the options. */
  readonly challenge?: string;
  /** False leaves the user-verified flag out. */
  readonly userVerified?: boolean;
  /** False leaves the user-present flag out. */
  readonly userPresent?: boolean;
};

/** `ResponseTweaks` for a registration. */
export type RegistrationTweaks = ResponseTweaks & {
  /** The transports the browser reports, in place of `['internal']`. */
  readonly transports?: readonly string[];
};

/** `ResponseTweaks` for a sign-in. */
export type AuthenticationTweaks = ResponseTweaks & {
  /** The signature counter to report, in place of the next one (or 0 for an authenticator that does not count). */
  readonly signCount?: number;
  /** True signs something other than what the server will check. */
  readonly wrongSignature?: boolean;
  /** The user handle to return, in place of the one stored at registration; `null` leaves it out. */
  readonly userHandle?: string | null;
};

/**
 * A software authenticator: the authenticator and the browser of a passkey
 * ceremony in one object, for the passkey tests. It holds one credential.
 */
export type SoftwareAuthenticator = {
  /** The credential id as the browser sends it: base64url. */
  readonly credentialId: string;
  /** The credential's public key as COSE bytes, which is what the server stores. */
  readonly publicKey: Uint8Array;
  /** The key type of the credential. */
  readonly algorithm: SoftwareKeyAlgorithm;
  /** The last signature counter reported. Set it to put the authenticator ahead of or behind the server. */
  counter: number;
  /**
   * Answers `navigator.credentials.create()` for these options: the credential
   * is made on the first call and the same one is made again on later calls, as
   * an authenticator that ignores `excludeCredentials` would.
   */
  register(
    options: PublicKeyCredentialCreationOptionsJSON,
    tweaks?: RegistrationTweaks,
  ): RegistrationResponseJSON;
  /** Answers `navigator.credentials.get()` for these options, signing with the credential's key. */
  authenticate(
    options: PublicKeyCredentialRequestOptionsJSON,
    tweaks?: AuthenticationTweaks,
  ): AuthenticationResponseJSON;
};

/** A new key of `algorithm`: its public half as a COSE key, and a function that signs with the private half. */
function newKey(algorithm: SoftwareKeyAlgorithm) {
  const bytes = (value: string | undefined) => Buffer.from(value!, 'base64url');
  if (algorithm === 'ES256') {
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    const jwk = publicKey.export({ format: 'jwk' });
    return {
      // COSE_Key: kty 2 (EC2), alg -7 (ES256), crv 1 (P-256), x, y. The keys are
      // in the order CTAP2 writes them: unsigned integers first, then negative.
      cose: new Map<string | number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, bytes(jwk.x)],
        [-3, bytes(jwk.y)],
      ]),
      sign: (data: Uint8Array) => sign('sha256', data, privateKey),
    };
  }
  if (algorithm === 'RS256') {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const jwk = publicKey.export({ format: 'jwk' });
    return {
      // kty 3 (RSA), alg -257 (RS256), n, e.
      cose: new Map<string | number, Cbor>([
        [1, 3],
        [3, -257],
        [-1, bytes(jwk.n)],
        [-2, bytes(jwk.e)],
      ]),
      sign: (data: Uint8Array) => sign('sha256', data, privateKey),
    };
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    // kty 1 (OKP), alg -8 (EdDSA), crv 6 (Ed25519), x.
    cose: new Map<string | number, Cbor>([
      [1, 1],
      [3, -8],
      [-1, 6],
      [-2, bytes(jwk.x)],
    ]),
    sign: (data: Uint8Array) => sign(null, data, privateKey),
  };
}

/**
 * Makes a software authenticator for the passkey tests. It builds what a real
 * authenticator and browser send (the client data JSON, the authenticator data,
 * a CBOR attestation object with `fmt: 'none'` made with the library's own CBOR
 * helper, and a signature made with Node's `crypto`), so a test runs the real
 * WebAuthn verification and not a stub. Only tests import this file.
 *
 * `counts` is false for a device that always reports a counter of 0, as many
 * synced passkeys do. `origin` is the site the browser is on. `credentialId`
 * (base64url) is given to make a second authenticator with the same credential
 * id, which a real one would never do.
 */
export function softwareAuthenticator(
  settings: {
    algorithm?: SoftwareKeyAlgorithm;
    counts?: boolean;
    origin?: string;
    credentialId?: string;
  } = {},
): SoftwareAuthenticator {
  const algorithm = settings.algorithm ?? 'ES256';
  const counts = settings.counts ?? true;
  const ownOrigin = settings.origin ?? 'https://osfpm.example.test';
  const key = newKey(algorithm);
  const publicKey = isoCBOR.encode(key.cose);
  const credentialId =
    settings.credentialId ?? randomBytes(32).toString('base64url');
  let userHandle: string | undefined;

  const authenticatorData = (input: {
    rpId: string;
    flags: number;
    signCount: number;
    attested: boolean;
  }) => {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(input.signCount);
    const parts: Uint8Array[] = [
      createHash('sha256').update(input.rpId, 'utf8').digest(),
      Buffer.from([input.flags]),
      counter,
    ];
    if (input.attested) {
      const idBytes = Buffer.from(credentialId, 'base64url');
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(idBytes.length);
      // The AAGUID is all zeros, as for an authenticator that does not say what it is.
      parts.push(Buffer.alloc(16), idLength, idBytes, publicKey);
    }
    return Buffer.concat(parts);
  };
  const flagsOf = (tweaks: ResponseTweaks, attested: boolean) =>
    (tweaks.userPresent === false ? 0 : FLAG_USER_PRESENT) |
    (tweaks.userVerified === false ? 0 : FLAG_USER_VERIFIED) |
    (attested ? FLAG_ATTESTED_CREDENTIAL_DATA : 0);
  const clientData = (
    type: 'webauthn.create' | 'webauthn.get',
    challenge: string,
    origin: string,
  ) =>
    Buffer.from(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
      'utf8',
    );

  const authenticator: SoftwareAuthenticator = {
    credentialId,
    publicKey,
    algorithm,
    counter: 0,
    register(options, tweaks = {}) {
      userHandle = options.user.id;
      const authData = authenticatorData({
        rpId: tweaks.rpId ?? options.rp.id ?? '',
        flags: flagsOf(tweaks, true),
        signCount: authenticator.counter,
        attested: true,
      });
      const attestationObject = isoCBOR.encode(
        new Map<string | number, Cbor>([
          ['fmt', 'none'],
          ['attStmt', new Map<string | number, Cbor>()],
          ['authData', authData],
        ]),
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData(
            'webauthn.create',
            tweaks.challenge ?? options.challenge,
            tweaks.origin ?? ownOrigin,
          ).toString('base64url'),
          attestationObject:
            Buffer.from(attestationObject).toString('base64url'),
          transports: [...(tweaks.transports ?? ['internal'])],
        },
      };
    },
    authenticate(options, tweaks = {}) {
      if (tweaks.signCount === undefined && counts) authenticator.counter += 1;
      const signCount =
        tweaks.signCount ?? (counts ? authenticator.counter : 0);
      const authData = authenticatorData({
        rpId: tweaks.rpId ?? options.rpId ?? '',
        flags: flagsOf(tweaks, false),
        signCount,
        attested: false,
      });
      const clientDataJSON = clientData(
        'webauthn.get',
        tweaks.challenge ?? options.challenge,
        tweaks.origin ?? ownOrigin,
      );
      const signed = Buffer.concat([
        authData,
        createHash('sha256').update(clientDataJSON).digest(),
        // One byte more than the server will check, so the signature is well
        // formed and still wrong.
        ...(tweaks.wrongSignature === true ? [Buffer.from([0])] : []),
      ]);
      const handle =
        tweaks.userHandle === undefined ? userHandle : tweaks.userHandle;
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: key.sign(signed).toString('base64url'),
          ...(handle === undefined || handle === null
            ? {}
            : { userHandle: handle }),
        },
      };
    },
  };
  return authenticator;
}

/**
 * "é" as one code point. Strings whose Unicode form matters are built from code
 * points in the tests, never typed: the composed and the decomposed spelling
 * look the same on a screen, and an editor or a tool can change which one a
 * typed string is in.
 */
export const E_ACUTE_COMPOSED = String.fromCodePoint(0x00e9);

/** "é" as two code points: the letter, then the combining accent. NFC makes it `E_ACUTE_COMPOSED`. */
export const E_ACUTE_DECOMPOSED = `e${String.fromCodePoint(0x0301)}`;

/**
 * One code point that NFC writes as two (Devanagari QA, which is spelled KA and
 * NUKTA), for tests that count code points after normalisation.
 */
export const EXPANDS_UNDER_NFC = String.fromCodePoint(0x0958);

/**
 * `text` in full-width letters, and full-width spaces for spaces, which only a
 * compatibility fold (NFKC) turns back into plain ones. NFC leaves them alone,
 * so to a password they are other characters.
 */
export function fullWidth(text: string): string {
  return Array.from(text, (character) => {
    if (character === ' ') return String.fromCodePoint(0x3000);
    const code = character.codePointAt(0)!;
    // Basic Latin 0x21 to 0x7e sits at 0xff01 to 0xff5e.
    return code >= 0x21 && code <= 0x7e
      ? String.fromCodePoint(code + 0xfee0)
      : character;
  }).join('');
}

/**
 * The Argon2id PHC string of `password` made with settings other than the
 * current ones, as an older version of the server, with other parameters, would
 * have stored it. The password is normalised first, as the services do. Pass it
 * to `seedPassword` as `hash`. Only tests import this file.
 */
export function passwordHashWith(
  password: string,
  settings: {
    memoryKiB: number;
    passes: number;
    parallelism: number;
    saltBytes?: number;
    hashBytes?: number;
  },
): string {
  const salt = randomBytes(
    settings.saltBytes ?? PASSWORD_HASH_PARAMS.saltBytes,
  );
  const hash = argon2Sync('argon2id', {
    message: normalisePassword(password),
    nonce: salt,
    memory: settings.memoryKiB,
    passes: settings.passes,
    parallelism: settings.parallelism,
    tagLength: settings.hashBytes ?? PASSWORD_HASH_PARAMS.hashBytes,
  });
  const encode = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=${PASSWORD_HASH_PARAMS.version}$m=${settings.memoryKiB},t=${settings.passes},p=${settings.parallelism}$${encode(salt)}$${encode(hash)}`;
}
