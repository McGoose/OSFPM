import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing with Argon2id from `node:crypto`. The built-in `crypto.argon2`
 * is used, not a package: Node's documentation for the version in `.nvmrc`
 * (26) marks the `node:crypto` module `Stability: 2 - Stable` and gives
 * `crypto.argon2` no lower stability of its own. The hash is stored as a PHC
 * string, so the parameters travel with it and can be raised later (SC-10).
 *
 * The password policy (length, blocklist, and NFC normalisation of the
 * password) is not here: it is in `password-policy.ts`, and
 * `password-service.ts` normalises in one place before both setting and
 * checking a password. These functions hash exactly the string they are given.
 * Passwords and their hashes are never logged, never returned after they are
 * set, and never written to events (CLAUDE.md, Privacy rule).
 */

const deriveKey = promisify(argon2);

/**
 * The Argon2id parameters new hashes use. This is the one place they live.
 * `memoryKiB` and `passes` are the OWASP Password Storage Cheat Sheet minimum
 * for Argon2id (19 MiB, 2 iterations, parallelism 1), which keeps a login cheap
 * enough for a small install. Raise them here and `verifyPassword` reports
 * `needsRehash` for every older hash.
 */
export const PASSWORD_HASH_PARAMS = {
  /** Argon2 version 1.3, the only one `node:crypto` computes. */
  version: 19,
  /** Memory cost in KiB: 19456 is 19 MiB. */
  memoryKiB: 19456,
  /** Iterations (Argon2 `t`). */
  passes: 2,
  parallelism: 1,
  saltBytes: 16,
  hashBytes: 32,
} as const;

/** The parameters stored in a PHC string. */
type StoredParams = {
  readonly version: number;
  readonly memoryKiB: number;
  readonly passes: number;
  readonly parallelism: number;
};

// A stored hash is trusted, but a corrupt one must not ask for gigabytes or
// minutes of work. These bounds are far above any real setting.
const MAX_MEMORY_KIB = 1_048_576;
const MAX_PASSES = 64;
const MAX_PARALLELISM = 64;
const MIN_SALT_BYTES = 8;
const MIN_HASH_BYTES = 16;
const MAX_HASH_BYTES = 128;

// `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`, base64 without padding.
const PHC =
  /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

const encode = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

function parseHash(phc: unknown) {
  if (typeof phc !== 'string') return null;
  const match = PHC.exec(phc);
  if (!match) return null;
  const params: StoredParams = {
    version: Number(match[1]),
    memoryKiB: Number(match[2]),
    passes: Number(match[3]),
    parallelism: Number(match[4]),
  };
  const salt = Buffer.from(match[5]!, 'base64');
  const hash = Buffer.from(match[6]!, 'base64');
  const withinBounds =
    params.version === PASSWORD_HASH_PARAMS.version &&
    params.parallelism >= 1 &&
    params.parallelism <= MAX_PARALLELISM &&
    params.passes >= 1 &&
    params.passes <= MAX_PASSES &&
    params.memoryKiB >= 8 * params.parallelism &&
    params.memoryKiB <= MAX_MEMORY_KIB &&
    salt.length >= MIN_SALT_BYTES &&
    hash.length >= MIN_HASH_BYTES &&
    hash.length <= MAX_HASH_BYTES;
  return withinBounds ? { params, salt, hash } : null;
}

function derive(
  password: string,
  salt: Buffer,
  params: StoredParams,
  hashBytes: number,
): Promise<Buffer> {
  return deriveKey('argon2id', {
    message: password,
    nonce: salt,
    memory: params.memoryKiB,
    passes: params.passes,
    parallelism: params.parallelism,
    tagLength: hashBytes,
  });
}

/**
 * Hashes a password with Argon2id and a fresh random salt, and returns the PHC
 * string to store. The same password gives a different string every time.
 * Runs on the thread pool, so it does not block the event loop. Anyone may call
 * it; it checks no permission and no password policy.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PASSWORD_HASH_PARAMS.saltBytes);
  const hash = await derive(
    password,
    salt,
    PASSWORD_HASH_PARAMS,
    PASSWORD_HASH_PARAMS.hashBytes,
  );
  const { version, memoryKiB, passes, parallelism } = PASSWORD_HASH_PARAMS;
  return `$argon2id$v=${version}$m=${memoryKiB},t=${passes},p=${parallelism}$${encode(salt)}$${encode(hash)}`;
}

/**
 * Checks a password against a stored PHC string. `ok` is whether it matches,
 * compared in constant time. `needsRehash` is true only for a correct password
 * whose stored hash uses other parameters than `PASSWORD_HASH_PARAMS`, so the
 * caller can store a new hash while it holds the password. A malformed hash, or
 * one asking for implausible work, is `{ ok: false, needsRehash: false }`; it
 * never throws and never says why.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const parsed = parseHash(storedHash);
  if (!parsed || typeof password !== 'string') {
    return { ok: false, needsRehash: false };
  }
  let derived: Buffer;
  try {
    derived = await derive(
      password,
      parsed.salt,
      parsed.params,
      parsed.hash.length,
    );
  } catch {
    return { ok: false, needsRehash: false };
  }
  const ok = timingSafeEqual(derived, parsed.hash);
  const current: StoredParams = PASSWORD_HASH_PARAMS;
  const needsRehash =
    ok &&
    (parsed.params.memoryKiB !== current.memoryKiB ||
      parsed.params.passes !== current.passes ||
      parsed.params.parallelism !== current.parallelism ||
      parsed.salt.length !== PASSWORD_HASH_PARAMS.saltBytes ||
      parsed.hash.length !== PASSWORD_HASH_PARAMS.hashBytes);
  return { ok, needsRehash };
}
