import {
  argon2Sync,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
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
import {
  base,
  grantOnProject,
  ORIGIN,
  seedDepartment,
  seedOrganisation,
  seedProject,
  seedUser,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  apiToken,
  installation,
  orgMembership,
  orgMembershipRole,
  passkeyCredential,
  passwordCredential,
  role,
  rolePermission,
  totpCredential,
  user,
  type OrgMembershipStatus,
  type OrgRole,
  type RolePermissionReach,
} from '../db/schema/index.js';
import { ensureInstallation } from './ensure-installation.js';
import {
  completeFirstRunSetup,
  type FirstRunSetupInput,
} from './first-run-setup.js';
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

/**
 * Makes `userId` a member of the organisation with the tier given, linked to the
 * organisation roles in `roleIds`, by direct inserts as fixtures do. `status`
 * defaults to `active`; `deleted` marks the membership row soft-deleted. Answers
 * the membership id.
 */
export async function seedMembership(
  database: Database,
  organisationId: string,
  userId: string,
  tier: OrgRole,
  roleIds: readonly string[],
  options: { status?: OrgMembershipStatus; deleted?: boolean } = {},
): Promise<string> {
  const [membership] = await database.db
    .insert(orgMembership)
    .values({
      ...base(organisationId),
      userId,
      orgRole: tier,
      status: options.status ?? 'active',
      deletedAt: options.deleted ? new Date() : null,
    })
    .returning();
  for (const roleId of roleIds) {
    await database.db.insert(orgMembershipRole).values({
      ...base(organisationId),
      membershipId: membership!.id,
      roleId,
    });
  }
  return membership!.id;
}

/**
 * An organisation role (no project) with the grants given as `[permission key,
 * reach, department id or null]`, by direct inserts. The keys must already be in
 * the catalogue. Answers the role id.
 */
export async function seedOrganisationRole(
  database: Database,
  organisationId: string,
  key: string,
  grants: readonly (readonly [string, RolePermissionReach, (string | null)?])[],
): Promise<string> {
  const [created] = await database.db
    .insert(role)
    .values({ ...base(organisationId), projectId: null, key, name: key })
    .returning();
  for (const [permissionKey, reach, departmentId] of grants) {
    await database.db.insert(rolePermission).values({
      ...base(organisationId),
      roleId: created!.id,
      permissionKey,
      reach,
      departmentId: departmentId ?? null,
    });
  }
  return created!.id;
}

let passkeyCounter = 0;

/**
 * Gives a user a passkey row directly, with an invented credential id and key,
 * revoked at `revokedAt` when that is given. Not a real WebAuthn credential: for
 * tests that count passkeys and revoke them, not for a sign-in. Answers the row id.
 */
export async function seedPasskey(
  database: Database,
  userId: string,
  options: { revokedAt?: Date } = {},
): Promise<string> {
  passkeyCounter += 1;
  const [row] = await database.db
    .insert(passkeyCredential)
    .values({
      originServer: ORIGIN,
      userId,
      credentialId: `fixture-credential-${passkeyCounter}-${newId()}`,
      publicKey: Buffer.from([1, 2, 3, 4]),
      deviceName: `Fixture device ${passkeyCounter}`,
      revokedAt: options.revokedAt ?? null,
    })
    .returning();
  return row!.id;
}

/** What `seedResetScene` made. */
export type ResetScene = {
  readonly organisationId: string;
  /** The first administrator: tier `owner`, the Administrator role (every permission). */
  readonly ownerId: string;
  /** Tier `admin`, also the Administrator role: every permission, but not an owner. */
  readonly adminId: string;
  /** Tier `member`, a role that holds only `members:reset-access`. */
  readonly resetterId: string;
  /** Tier `member`, a role that holds only `accounts:read`: may not reset anyone. */
  readonly plainId: string;
  /** A member of the other organisation only. */
  readonly strangerId: string;
  /** A second organisation, with its own project and department. */
  readonly otherOrganisationId: string;
  /** The department of the first organisation, for a grant limited to one. */
  readonly departmentId: string;
  /** The organisation roles of the first organisation, by what they hold. */
  readonly roles: {
    readonly administrator: string;
    /** `members:reset-access`, in the organisation only. */
    readonly resetter: string;
    /** `accounts:read`, in the organisation only. */
    readonly crew: string;
    /** `accounts:read` and `accounts:edit`, in the organisation only. */
    readonly editor: string;
    /** `accounts:read`, in every project. */
    readonly wide: string;
  };
};

/**
 * An organisation made by first-run setup (so it has its owner, the Administrator
 * role and the permission catalogue) with the people admin reset links are tried
 * on: an administrator who is not an owner, a member who may only reset, a member
 * who may not, and a stranger in another organisation. Direct inserts for the
 * extras, as fixtures do. Invented people only.
 */
export async function seedResetScene(
  database: Database,
  now: Date,
): Promise<ResetScene> {
  const code = await seedFirstRun(database, now);
  const done = await completeFirstRunSetup(
    database.db,
    demoSetupInput(code),
    now,
  );
  if (!done.ok) throw new Error('the setup was refused');
  const organisationId = done.organisation.id;
  const [administrator] = await database.db.select().from(role);
  const other = await seedOrganisation(database);
  const departmentId = await seedDepartment(database, organisationId, 'camera');
  const roles = {
    administrator: administrator!.id,
    resetter: await seedOrganisationRole(database, organisationId, 'resetter', [
      ['members:reset-access', 'own-scope'],
    ]),
    crew: await seedOrganisationRole(database, organisationId, 'crew', [
      ['accounts:read', 'own-scope'],
    ]),
    editor: await seedOrganisationRole(database, organisationId, 'editor', [
      ['accounts:read', 'own-scope'],
      ['accounts:edit', 'own-scope'],
    ]),
    wide: await seedOrganisationRole(database, organisationId, 'wide', [
      ['accounts:read', 'all-projects'],
    ]),
  };
  const adminId = await seedUser(database);
  await seedMembership(database, organisationId, adminId, 'admin', [
    roles.administrator,
  ]);
  const resetterId = await seedUser(database);
  await seedMembership(database, organisationId, resetterId, 'member', [
    roles.resetter,
  ]);
  const plainId = await seedUser(database);
  await seedMembership(database, organisationId, plainId, 'member', [
    roles.crew,
  ]);
  const strangerId = await seedUser(database);
  await seedMembership(
    database,
    other.organisationId,
    strangerId,
    'member',
    [],
  );
  return {
    organisationId,
    ownerId: done.user.id,
    adminId,
    resetterId,
    plainId,
    strangerId,
    otherOrganisationId: other.organisationId,
    departmentId,
    roles,
  };
}

/**
 * Changes the tier of a member's membership directly, as a later release's own
 * service would, so a test can show what a reset link does when the situation
 * changes after it was made.
 */
export async function setMembershipTier(
  database: Database,
  organisationId: string,
  userId: string,
  tier: OrgRole,
): Promise<void> {
  await database.db
    .update(orgMembership)
    .set({ orgRole: tier })
    .where(
      and(
        eq(orgMembership.organisationId, organisationId),
        eq(orgMembership.userId, userId),
      ),
    );
}

/**
 * Changes the status of a member's membership directly (`removed`, `invited` or
 * `active`), as a later release's own service would, so a test can show what a
 * reset link does when the membership stops being active after the link was made.
 */
export async function setMembershipStatus(
  database: Database,
  organisationId: string,
  userId: string,
  status: OrgMembershipStatus,
): Promise<void> {
  await database.db
    .update(orgMembership)
    .set({ status })
    .where(
      and(
        eq(orgMembership.organisationId, organisationId),
        eq(orgMembership.userId, userId),
      ),
    );
}

/** What `seedTokenScene` made. */
export type TokenScene = {
  readonly organisationId: string;
  /** The first administrator: tier `owner`, the Administrator role (every permission). */
  readonly ownerId: string;
  /** A member whose role holds only `api:tokens`, in the organisation. */
  readonly tokensId: string;
  /** A member whose role holds only `api:manage`, in the organisation. */
  readonly managerId: string;
  /**
   * A member who holds `api:tokens` and the medical read and edit permissions in the
   * organisation, and the medical read permission on `projectId` through a project role.
   */
  readonly medicalId: string;
  /** A member who holds none of the API permissions. */
  readonly plainId: string;
  /** A member of the other organisation only. */
  readonly strangerId: string;
  readonly otherOrganisationId: string;
  /** A project of the organisation. */
  readonly projectId: string;
  /** A second project of the organisation. */
  readonly otherProjectId: string;
  /** A project of the other organisation. */
  readonly foreignProjectId: string;
};

/**
 * An organisation made by first-run setup, with the people personal API token tests
 * need: the owner (every permission), one member who may only make tokens, one who may
 * only manage them, one who may make tokens and holds medical data permissions, one who
 * holds none of it, and a stranger in another organisation, plus two projects of the
 * organisation and one of the other. Direct inserts for the extras, as fixtures do.
 * Invented people only.
 */
export async function seedTokenScene(
  database: Database,
  now: Date,
): Promise<TokenScene> {
  const reset = await seedResetScene(database, now);
  const { organisationId } = reset;
  const roles = {
    tokens: await seedOrganisationRole(database, organisationId, 'tokens', [
      ['api:tokens', 'own-scope'],
    ]),
    manager: await seedOrganisationRole(database, organisationId, 'manager', [
      ['api:manage', 'own-scope'],
    ]),
    medical: await seedOrganisationRole(database, organisationId, 'medical', [
      ['api:tokens', 'own-scope'],
      ['sensitive:read:medical', 'own-scope'],
      ['sensitive:edit:medical', 'own-scope'],
    ]),
  };
  const member = async (roleId: string) => {
    const id = await seedUser(database);
    await seedMembership(database, organisationId, id, 'member', [roleId]);
    return id;
  };
  const tokensId = await member(roles.tokens);
  const managerId = await member(roles.manager);
  const medicalId = await member(roles.medical);
  const projectId = await seedProject(database, organisationId);
  const otherProjectId = await seedProject(database, organisationId);
  // A project role on `projectId` that holds the medical read permission, so the
  // member holds it there and not only in the organisation.
  await grantOnProject(
    database,
    organisationId,
    projectId,
    medicalId,
    ['sensitive:read:medical'],
    { roleProjectId: projectId },
  );
  const foreign = await seedOrganisation(database);
  return {
    organisationId,
    ownerId: reset.ownerId,
    tokensId,
    managerId,
    medicalId,
    plainId: reset.plainId,
    strangerId: reset.strangerId,
    otherOrganisationId: reset.otherOrganisationId,
    projectId,
    otherProjectId,
    foreignProjectId: foreign.projectId,
  };
}

let apiTokenCounter = 0;

/**
 * A personal API token row, written directly as fixtures do (the service that makes
 * one is under test elsewhere). A `read` token for `userId`, with no project and no
 * sensitive scope, that never expires, with a fixture hash and prefix, made on 1
 * January 2026 so that an `expiresAt` any test sets after that day is valid.
 * `overrides` change any column. `userId` must be a member of `organisationId`.
 * Answers the row.
 */
export async function seedApiToken(
  database: Database,
  organisationId: string,
  userId: string,
  overrides: Partial<typeof apiToken.$inferInsert> = {},
): Promise<typeof apiToken.$inferSelect> {
  apiTokenCounter += 1;
  const n = apiTokenCounter;
  const [row] = await database.db
    .insert(apiToken)
    .values({
      originServer: ORIGIN,
      organisationId,
      userId,
      name: `Fixture token ${n}`,
      prefix: `osfpm_pat_fx${String(n).padStart(6, '0')}`,
      tokenHash: `fixture-token-hash-${n}-${newId()}`,
      access: 'read',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      createdBy: userId,
      ...overrides,
    })
    .returning();
  return row!;
}
