import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../db/ids.js';
import { ServerKeysError } from './errors.js';
import {
  loadServerKeys,
  permissionsTooOpen,
  SERVER_KEY_FILES,
} from './server-keys.js';
import {
  createTestKeyDirectory,
  type TestKeyDirectory,
} from './test-support.js';

const POSIX = process.platform !== 'win32';
const AAD = 'totp_credential:018f0000-0000-7000-8000-000000000001';
const SECRET = 'JBSWY3DPEHPK3PXP';

let scratch: TestKeyDirectory;
beforeEach(() => {
  scratch = createTestKeyDirectory();
});
afterEach(() => scratch.remove());

/** The mode bits of `path` that say who may do what. */
const modeOf = (path: string) => statSync(path).mode & 0o777;

/** The ServerKeysError `action` throws, or a failed expectation. */
function refusal(action: () => unknown): ServerKeysError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ServerKeysError);
    return error as ServerKeysError;
  }
  throw new Error('expected a ServerKeysError, but nothing was thrown');
}

/** The data key files and `current` in a key directory. */
function dataKeyFiles(dir: string): string[] {
  const folder = join(dir, SERVER_KEY_FILES.dataKeysDirectory);
  return existsSync(folder) ? readdirSync(folder).sort() : [];
}

describe('permissionsTooOpen', () => {
  it('is true for any group or other permission bit and false for the owner alone', () => {
    expect(permissionsTooOpen(0o600)).toBe(false);
    expect(permissionsTooOpen(0o400)).toBe(false);
    expect(permissionsTooOpen(0o700)).toBe(false);
    expect(permissionsTooOpen(0o640)).toBe(true);
    expect(permissionsTooOpen(0o604)).toBe(true);
    expect(permissionsTooOpen(0o660)).toBe(true);
    expect(permissionsTooOpen(0o644)).toBe(true);
    expect(permissionsTooOpen(0o100010)).toBe(true);
    expect(permissionsTooOpen(0o100600)).toBe(false);
  });
});

describe('loadServerKeys: first start', () => {
  it('creates the identity key, a data key and current in an empty directory', () => {
    const keys = loadServerKeys(scratch.dir);

    const identityPem = readFileSync(
      join(scratch.dir, SERVER_KEY_FILES.identity),
      'utf8',
    );
    expect(identityPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    const files = dataKeyFiles(scratch.dir);
    expect(files).toHaveLength(2);
    expect(files).toContain(SERVER_KEY_FILES.current);
    expect(files).toContain(`${keys.dataKeys.currentKeyId}.key`);
    expect(
      readFileSync(
        join(
          scratch.dir,
          SERVER_KEY_FILES.dataKeysDirectory,
          SERVER_KEY_FILES.current,
        ),
        'utf8',
      ).trim(),
    ).toBe(keys.dataKeys.currentKeyId);
    expect(keys.dataKeys.currentKeyId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('writes a data key as 32 random bytes in base64', () => {
    const keys = loadServerKeys(scratch.dir);
    const text = readFileSync(
      join(
        scratch.dir,
        SERVER_KEY_FILES.dataKeysDirectory,
        `${keys.dataKeys.currentKeyId}.key`,
      ),
      'utf8',
    ).trim();
    expect(Buffer.from(text, 'base64')).toHaveLength(32);
    expect(Buffer.from(text, 'base64').toString('base64')).toBe(text);
  });

  it('makes an Ed25519 key whose published form is the raw 32-byte public key in base64url', () => {
    const keys = loadServerKeys(scratch.dir);
    const raw = Buffer.from(keys.identity.publicKey, 'base64url');
    expect(raw).toHaveLength(32);
    expect(raw.toString('base64url')).toBe(keys.identity.publicKey);

    // The same key as the file holds, seen by node:crypto directly.
    const fromFile = createPublicKey(
      readFileSync(join(scratch.dir, SERVER_KEY_FILES.identity), 'utf8'),
    );
    expect(fromFile.asymmetricKeyType).toBe('ed25519');
    expect(fromFile.export({ format: 'jwk' }).x).toBe(keys.identity.publicKey);
  });

  it('signs so that the published public key verifies the signature', () => {
    const { identity } = loadServerKeys(scratch.dir);
    const message = Buffer.from('a message for the signature');
    const signature = identity.sign(message);
    const published = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: identity.publicKey },
      format: 'jwk',
    });
    expect(verify(null, message, published, signature)).toBe(true);
    expect(verify(null, Buffer.from('another'), published, signature)).toBe(
      false,
    );
  });

  it('gives a fingerprint that is the SHA-256 of the raw key, in hex, in groups of four', () => {
    const { identity } = loadServerKeys(scratch.dir);
    expect(identity.fingerprint).toMatch(/^([0-9a-f]{4} ){15}[0-9a-f]{4}$/);
    const digest = createHash('sha256')
      .update(Buffer.from(identity.publicKey, 'base64url'))
      .digest('hex');
    expect(identity.fingerprint.replaceAll(' ', '')).toBe(digest);
  });

  it.skipIf(!POSIX)(
    'creates the directories as 0700 and every key file as 0600',
    () => {
      const nested = join(scratch.dir, 'not', 'there', 'yet');
      loadServerKeys(nested);

      expect(modeOf(nested)).toBe(0o700);
      expect(modeOf(join(nested, SERVER_KEY_FILES.dataKeysDirectory))).toBe(
        0o700,
      );
      expect(modeOf(join(nested, SERVER_KEY_FILES.identity))).toBe(0o600);
      for (const name of dataKeyFiles(nested)) {
        expect(
          modeOf(join(nested, SERVER_KEY_FILES.dataKeysDirectory, name)),
        ).toBe(0o600);
      }
    },
  );
});

describe('loadServerKeys: later starts', () => {
  it('reuses the same keys and writes nothing new', () => {
    const first = loadServerKeys(scratch.dir);
    const filesBefore = dataKeyFiles(scratch.dir);
    const sealed = first.dataKeys.encrypt(SECRET, AAD);

    const second = loadServerKeys(scratch.dir);

    expect(second.identity.publicKey).toBe(first.identity.publicKey);
    expect(second.dataKeys.currentKeyId).toBe(first.dataKeys.currentKeyId);
    expect(dataKeyFiles(scratch.dir)).toEqual(filesBefore);
    expect(second.dataKeys.decrypt(sealed, AAD)).toBe(SECRET);
  });

  it('holds a data key added by hand and still opens what the old one sealed', () => {
    const first = loadServerKeys(scratch.dir);
    const sealedByOld = first.dataKeys.encrypt(SECRET, AAD);

    // What a later rotation tool will do: a new key file, then `current`.
    const newKeyId = newId();
    const folder = join(scratch.dir, SERVER_KEY_FILES.dataKeysDirectory);
    writeFileSync(
      join(folder, `${newKeyId}.key`),
      `${randomBytes(32).toString('base64')}\n`,
      { mode: 0o600 },
    );
    writeFileSync(join(folder, SERVER_KEY_FILES.current), `${newKeyId}\n`, {
      mode: 0o600,
    });

    const second = loadServerKeys(scratch.dir);

    expect(second.dataKeys.currentKeyId).toBe(newKeyId);
    expect(second.dataKeys.encrypt(SECRET, AAD).split('.')[1]).toBe(newKeyId);
    expect(second.dataKeys.decrypt(sealedByOld, AAD)).toBe(SECRET);
    expect(dataKeyFiles(scratch.dir)).toHaveLength(3);
  });
});

describe('loadServerKeys: permissions', () => {
  it.skipIf(!POSIX)('refuses an identity key that group can read', () => {
    loadServerKeys(scratch.dir);
    const path = join(scratch.dir, SERVER_KEY_FILES.identity);
    chmodSync(path, 0o640);

    const error = refusal(() => loadServerKeys(scratch.dir));

    expect(error.reason).toBe('permissions');
    expect(error.message).toContain(path);
  });

  it.skipIf(!POSIX)('refuses a data key that others can read', () => {
    const keys = loadServerKeys(scratch.dir);
    const path = join(
      scratch.dir,
      SERVER_KEY_FILES.dataKeysDirectory,
      `${keys.dataKeys.currentKeyId}.key`,
    );
    chmodSync(path, 0o604);

    const error = refusal(() => loadServerKeys(scratch.dir));

    expect(error.reason).toBe('permissions');
    expect(error.message).toContain(path);
  });

  it.skipIf(!POSIX)(
    'does not check the mode of current, which holds a key id and no secret',
    () => {
      const keys = loadServerKeys(scratch.dir);
      chmodSync(
        join(
          scratch.dir,
          SERVER_KEY_FILES.dataKeysDirectory,
          SERVER_KEY_FILES.current,
        ),
        0o644,
      );

      expect(loadServerKeys(scratch.dir).dataKeys.currentKeyId).toBe(
        keys.dataKeys.currentKeyId,
      );
    },
  );

  it.skipIf(!POSIX)('names the path and never the contents of the file', () => {
    const keys = loadServerKeys(scratch.dir);
    const path = join(scratch.dir, SERVER_KEY_FILES.identity);
    chmodSync(path, 0o644);

    const error = refusal(() => loadServerKeys(scratch.dir));

    const pem = readFileSync(path, 'utf8');
    for (const line of pem.split('\n').filter((l) => l.length > 20)) {
      expect(error.message).not.toContain(line);
    }
    expect(error.message).not.toContain(keys.identity.publicKey);
  });
});

describe('loadServerKeys: what is not created', () => {
  it('does not make an identity key when it is told it may not, and writes nothing', () => {
    const error = refusal(() =>
      loadServerKeys(scratch.dir, { identity: false, dataKeys: true }),
    );

    expect(error.reason).toBe('identity-missing');
    expect(existsSync(join(scratch.dir, SERVER_KEY_FILES.identity))).toBe(
      false,
    );
  });

  it('does not make data keys when it is told it may not', () => {
    // An identity key the directory already has, so only the data keys are missing.
    loadServerKeys(scratch.dir);
    rmSync(join(scratch.dir, SERVER_KEY_FILES.dataKeysDirectory), {
      recursive: true,
    });

    const error = refusal(() =>
      loadServerKeys(scratch.dir, { identity: true, dataKeys: false }),
    );

    expect(error.reason).toBe('data-keys-missing');
    expect(dataKeyFiles(scratch.dir)).toEqual([]);
  });

  it('treats a current that names a missing file as missing data keys', () => {
    const keys = loadServerKeys(scratch.dir);
    const folder = join(scratch.dir, SERVER_KEY_FILES.dataKeysDirectory);
    rmSync(join(folder, `${keys.dataKeys.currentKeyId}.key`));

    const error = refusal(() =>
      loadServerKeys(scratch.dir, { identity: true, dataKeys: false }),
    );
    expect(error.reason).toBe('data-keys-missing');

    // Allowed to create, it makes a new key and points current at it.
    const fresh = loadServerKeys(scratch.dir);
    expect(fresh.dataKeys.currentKeyId).not.toBe(keys.dataKeys.currentKeyId);
  });

  it('makes fresh data keys, and keeps the identity key, when only the data keys are gone', () => {
    const first = loadServerKeys(scratch.dir);
    rmSync(join(scratch.dir, SERVER_KEY_FILES.dataKeysDirectory), {
      recursive: true,
    });

    const second = loadServerKeys(scratch.dir);

    expect(second.identity.publicKey).toBe(first.identity.publicKey);
    expect(second.dataKeys.currentKeyId).not.toBe(first.dataKeys.currentKeyId);
  });
});

describe('loadServerKeys: files that are not keys', () => {
  it('refuses an identity file that is not an Ed25519 private key, naming the path only', () => {
    const path = join(scratch.dir, SERVER_KEY_FILES.identity);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const content of [
      'a recognisable marker that must not be echoed\n',
      rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    ]) {
      writeFileSync(path, content, { mode: 0o600 });
      const error = refusal(() => loadServerKeys(scratch.dir));
      expect(error.reason).toBe('invalid');
      expect(error.message).toContain(path);
      expect(error.message).not.toContain('recognisable marker');
      expect(error.message).not.toContain('BEGIN');
    }
  });

  it('refuses a data key that is not 32 bytes of base64, and current that is not an id', () => {
    const keys = loadServerKeys(scratch.dir);
    const folder = join(scratch.dir, SERVER_KEY_FILES.dataKeysDirectory);
    const keyPath = join(folder, `${keys.dataKeys.currentKeyId}.key`);
    writeFileSync(keyPath, `${randomBytes(16).toString('base64')}\n`, {
      mode: 0o600,
    });
    expect(refusal(() => loadServerKeys(scratch.dir)).reason).toBe('invalid');

    writeFileSync(keyPath, `${randomBytes(32).toString('base64')}\n`, {
      mode: 0o600,
    });
    writeFileSync(join(folder, SERVER_KEY_FILES.current), 'not an id\n', {
      mode: 0o600,
    });
    expect(refusal(() => loadServerKeys(scratch.dir)).reason).toBe('invalid');
  });

  it('refuses a key file that is a directory, as unreadable', () => {
    mkdirSync(join(scratch.dir, SERVER_KEY_FILES.identity), { mode: 0o700 });
    expect(refusal(() => loadServerKeys(scratch.dir)).reason).toBe(
      'unreadable',
    );
  });

  it('ignores a file in data-keys that is not a key file', () => {
    const keys = loadServerKeys(scratch.dir);
    writeFileSync(
      join(scratch.dir, SERVER_KEY_FILES.dataKeysDirectory, 'notes.txt'),
      'not a key',
    );
    expect(loadServerKeys(scratch.dir).dataKeys.currentKeyId).toBe(
      keys.dataKeys.currentKeyId,
    );
  });
});
