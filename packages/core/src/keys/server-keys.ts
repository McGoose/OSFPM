import {
  generateKeyPairSync,
  createPrivateKey,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { newId } from '../db/ids.js';
import { DataKeyRing } from './data-keys.js';
import { ServerKeysError } from './errors.js';
import { ServerIdentity } from './identity.js';

/**
 * The only file input and output of the server keys. Everything the server
 * keeps outside the database is read, made and checked here: the identity key
 * pair and the data keys (spec, section Cryptography and keys). The files are
 * never in the database, a log, an error, an audit event or a change event
 * (CLAUDE.md, Data rules).
 */

/** The names inside the key directory, in one place. */
export const SERVER_KEY_FILES = {
  /** The Ed25519 private key, PKCS #8 PEM. */
  identity: 'server-identity.pem',
  /** The folder of data keys. */
  dataKeysDirectory: 'data-keys',
  /** The file in `dataKeysDirectory` that names the key new values are sealed with. */
  current: 'current',
} as const;

/** A data key file is `<key id>.key`, the id being a UUIDv7. */
const DATA_KEY_FILE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.key$/;

/** A key id, as `current` holds it. */
const KEY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** What `loadServerKeys` hands out: the identity pair and the data-key ring. */
export type ServerKeys = {
  readonly identity: ServerIdentity;
  readonly dataKeys: DataKeyRing;
};

/**
 * Which missing parts `loadServerKeys` may make. Both are true by default. The
 * start-up step sets one to false when the database says the part must already
 * exist: an identity key when the installation has stored one, data keys when
 * the database holds a sealed secret. A missing part is then a refusal and
 * nothing is written, so a swapped or empty volume is never quietly given new
 * keys.
 */
export type KeyCreation = {
  readonly identity: boolean;
  readonly dataKeys: boolean;
};

/** True when a mode lets the group or others do anything with the file. */
export function permissionsTooOpen(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

/** True for the error `fs` throws for a path that is not there. */
function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Refuses a key file that the group or others may read. The check is for POSIX
 * systems. Windows has no such mode bits (the mode `fs` reports there is a
 * fixed value that says nothing about who can read the file), so the check is
 * skipped there and the operator relies on the folder's access rules.
 * `statSync` follows a symbolic link, which is what a mounted secret is.
 *
 * @throws ServerKeysError `permissions` naming the path.
 */
function assertPrivate(path: string): void {
  if (process.platform === 'win32') return;
  if (permissionsTooOpen(statSync(path).mode)) {
    throw new ServerKeysError('permissions', path);
  }
}

/**
 * The text of the file at `path`, or null when it is not there. The permissions
 * of a file that holds a secret are checked first; `current`, which holds a key id
 * and no secret, is not checked, so an operator who made it by hand with the
 * default mode is not refused for it.
 *
 * @throws ServerKeysError `permissions` when others can read it, `unreadable`
 * when it is there and cannot be read (a directory, or no right to read).
 */
function readKeyFile(path: string, holdsSecret = true): string | null {
  try {
    if (holdsSecret) assertPrivate(path);
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ServerKeysError) throw error;
    if (isMissing(error)) return null;
    // The system's message is dropped: it may quote the path or more.
    throw new ServerKeysError('unreadable', path);
  }
}

/** Makes `dir` as 0700 when it is not there, and every folder above it that is missing. */
function ensureDirectory(dir: string): void {
  if (existsSync(dir)) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The mode of a recursive mkdir is not applied to every folder on every system.
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
  } catch {
    throw new ServerKeysError('unreadable', dir);
  }
}

/**
 * Writes `text` to a new file at `path`, mode 0600, and fails if the file is
 * there already (`wx`), so a key file is never overwritten.
 *
 * @throws ServerKeysError `unreadable` when the file cannot be made.
 * @returns false when the file was already there (another server made it).
 */
function createKeyFile(path: string, text: string): boolean {
  try {
    writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'EEXIST') return false;
    throw new ServerKeysError('unreadable', path);
  }
}

/**
 * The identity key of the directory, or null when there is no file. A file that
 * is not an Ed25519 private key is a refusal, not a reason to make another.
 */
function readIdentity(dir: string): ServerIdentity | null {
  const path = join(dir, SERVER_KEY_FILES.identity);
  const text = readKeyFile(path);
  if (text === null) return null;
  try {
    const key = createPrivateKey({ key: text, format: 'pem' });
    return new ServerIdentity(key);
  } catch {
    // Neither the library's message nor the file's text goes into the error.
    throw new ServerKeysError('invalid', path);
  }
}

/** Makes the identity key pair and writes the private half; returns the identity. */
function createIdentity(dir: string): ServerIdentity {
  const path = join(dir, SERVER_KEY_FILES.identity);
  ensureDirectory(dir);
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  if (!createKeyFile(path, pem)) {
    // Another server made it between our read and our write: use theirs.
    const existing = readIdentity(dir);
    if (existing === null) throw new ServerKeysError('unreadable', path);
    return existing;
  }
  return new ServerIdentity(privateKey);
}

/** The key of one data key file, checked to be 32 bytes of canonical base64. */
function readDataKey(path: string): Buffer {
  const text = readKeyFile(path);
  if (text === null) throw new ServerKeysError('unreadable', path);
  const trimmed = text.trim();
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== 32 || key.toString('base64') !== trimmed) {
    throw new ServerKeysError('invalid', path);
  }
  return key;
}

/** The names of the files of `folder`, or none when it is not there. */
function listFolder(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch (error) {
    if (isMissing(error)) return [];
    throw new ServerKeysError('unreadable', folder);
  }
}

/**
 * Every data key file of `folder`, by key id: each is read and checked, and one
 * that is not right is a refusal. Files that are not named like a key, such as a
 * note, are left alone.
 *
 * @throws ServerKeysError for a key file that cannot be used.
 */
function readDataKeyFiles(folder: string): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const name of listFolder(folder).sort()) {
    const match = DATA_KEY_FILE.exec(name);
    // Other files in the folder, such as a note, are not keys and are left alone.
    if (match === null) continue;
    keys.set(match[1]!, readDataKey(join(folder, name)));
  }
  return keys;
}

/** Replaces `current` with `keyId` in one step, so a reader never sees half of it. */
function writeCurrent(folder: string, keyId: string): void {
  const path = join(folder, SERVER_KEY_FILES.current);
  const temporary = join(folder, `${SERVER_KEY_FILES.current}.${keyId}.tmp`);
  try {
    writeFileSync(temporary, `${keyId}\n`, { mode: 0o600, flag: 'w' });
    renameSync(temporary, path);
  } catch {
    throw new ServerKeysError('unreadable', path);
  }
}

/**
 * Loads the data keys, and makes one new key (and points `current` at it) when
 * there is no usable current key and `mayCreate` is true. A usable current key
 * is one `current` names and whose file is there. Older keys are kept, so values
 * they sealed still open.
 *
 * @throws ServerKeysError `data-keys-missing` when there is no usable current
 * key and `mayCreate` is false, and the refusals of a bad file.
 */
function loadDataKeys(dir: string, mayCreate: boolean): DataKeyRing {
  const folder = join(dir, SERVER_KEY_FILES.dataKeysDirectory);
  const keys = readDataKeyFiles(folder);

  const currentPath = join(folder, SERVER_KEY_FILES.current);
  const currentText = readKeyFile(currentPath, false);
  let currentId: string | undefined;
  if (currentText !== null) {
    const named = currentText.trim();
    if (!KEY_ID.test(named)) throw new ServerKeysError('invalid', currentPath);
    if (keys.has(named)) currentId = named;
  }
  if (currentId !== undefined) return new DataKeyRing(keys, currentId);

  if (!mayCreate) throw new ServerKeysError('data-keys-missing');
  ensureDirectory(folder);
  const keyId = newId();
  const key = randomBytes(32);
  if (
    !createKeyFile(join(folder, `${keyId}.key`), `${key.toString('base64')}\n`)
  ) {
    // A new id is never taken, so this is not a race: something is wrong.
    throw new ServerKeysError('unreadable', join(folder, `${keyId}.key`));
  }
  keys.set(keyId, key);
  writeCurrent(folder, keyId);
  return new DataKeyRing(keys, keyId);
}

/**
 * Loads the server's keys from `dir` (`OSFPM_KEYS_DIR`) and makes any that are
 * missing, as the files `server-identity.pem` (an Ed25519 private key, PKCS #8
 * PEM), `data-keys/<key id>.key` (32 random bytes in base64) and
 * `data-keys/current` (the id of the key that seals new values). New directories
 * are mode 0700 and new files 0600. On POSIX systems a key file that the group or
 * others can read is refused; the directories, and `current`, which holds no
 * secret, are not checked. Existing files are
 * never changed, and a file that cannot be read or is not the right kind is a
 * refusal, never a reason to make a new one.
 *
 * `create` says which missing parts may be made (both, by default). The start-up
 * step turns one off when the database says that part already exists, so the
 * missing file means a wrong or empty volume and the server stops with
 * `identity-missing` or `data-keys-missing`, writing nothing.
 *
 * Runs once at start-up and the result is passed down to what needs it. Only
 * the start-up step and tests call it. Servers that share a directory call it
 * one at a time, under the installation row lock.
 *
 * @throws ServerKeysError for every refusal; its message names the path of a
 * file and never anything inside one.
 */
export function loadServerKeys(
  dir: string,
  create: KeyCreation = { identity: true, dataKeys: true },
): ServerKeys {
  const existing = readIdentity(dir);
  if (existing === null && !create.identity) {
    throw new ServerKeysError('identity-missing');
  }
  const identity = existing ?? createIdentity(dir);
  return { identity, dataKeys: loadDataKeys(dir, create.dataKeys) };
}

/**
 * The identity key of `dir`, or null when there is no `server-identity.pem`.
 * Reads and checks only: it never makes a key. The admin command line uses it to
 * compare the file with the public key the installation stored, and the key
 * commands to see what is there before they act. Only the public half leaves the
 * returned object.
 *
 * @throws ServerKeysError `permissions`, `unreadable` or `invalid`, as
 * `loadServerKeys` does; the message names a path and nothing from a file.
 */
export function readServerIdentity(dir: string): ServerIdentity | null {
  return readIdentity(dir);
}

/**
 * The data-key ring of `dir`, or null when there is no usable current key: the
 * `data-keys` folder is missing, or `current` is missing or names a file that is
 * not there. Reads and checks only: it never makes a key, which is what separates
 * it from `loadServerKeys` and lets the admin command line look at a directory it
 * must not change. A key file that is there is checked as `loadServerKeys` checks it.
 *
 * @throws ServerKeysError `permissions`, `unreadable` or `invalid` for a key file or
 * a `current` that cannot be used; the message names a path and nothing from a file.
 */
export function readDataKeyRing(dir: string): DataKeyRing | null {
  try {
    return loadDataKeys(dir, false);
  } catch (error) {
    if (
      error instanceof ServerKeysError &&
      error.reason === 'data-keys-missing'
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * What `inspectKeyDirectory` found. Counts and facts only: no key id, no file name
 * of a data key (the name is the key's id), and nothing from inside a file.
 */
export type KeyDirectoryReport = {
  /** The key directory is there and is a directory. */
  readonly exists: boolean;
  /** `server-identity.pem` is there, whatever it holds. */
  readonly identityFile: boolean;
  /** How many files in `data-keys` are named like a data key. */
  readonly dataKeyFiles: number;
  /** `data-keys/current` is there. */
  readonly currentFile: boolean;
  /**
   * How many key files (the identity key and the data keys) the group or others can
   * read, which the server refuses to start with. Null on Windows, whose mode bits
   * say nothing about access, so the question has no answer there.
   */
  readonly openFiles: number | null;
};

/**
 * Looks at the key directory without reading a key: which files are there, how
 * many data keys, and on POSIX systems how many key files are too open. It never
 * throws for what it finds (a directory that cannot be read counts as not being
 * there) and never makes or changes a file. The admin command line's `info` and
 * `doctor` use it, and nothing in the report is a secret.
 */
export function inspectKeyDirectory(dir: string): KeyDirectoryReport {
  let exists: boolean;
  try {
    exists = statSync(dir).isDirectory();
  } catch {
    exists = false;
  }
  const checkable = process.platform !== 'win32';
  if (!exists) {
    return {
      exists: false,
      identityFile: false,
      dataKeyFiles: 0,
      currentFile: false,
      openFiles: checkable ? 0 : null,
    };
  }
  const identityPath = join(dir, SERVER_KEY_FILES.identity);
  const folder = join(dir, SERVER_KEY_FILES.dataKeysDirectory);
  let names: string[];
  try {
    names = listFolder(folder);
  } catch {
    names = [];
  }
  const dataKeyPaths = names
    .filter((name) => DATA_KEY_FILE.test(name))
    .map((name) => join(folder, name));
  const identityFile = existsSync(identityPath);
  const tooOpen = (path: string) => {
    try {
      return permissionsTooOpen(statSync(path).mode);
    } catch {
      return false;
    }
  };
  return {
    exists: true,
    identityFile,
    dataKeyFiles: dataKeyPaths.length,
    currentFile: existsSync(join(folder, SERVER_KEY_FILES.current)),
    openFiles: checkable
      ? [...(identityFile ? [identityPath] : []), ...dataKeyPaths].filter(
          tooOpen,
        ).length
      : null,
  };
}
