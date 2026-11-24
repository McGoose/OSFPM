import {
  chmodSync,
  existsSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../db/ids.js';
import { ServerKeysError } from './errors.js';
import {
  inspectKeyDirectory,
  loadServerKeys,
  readDataKeyRing,
  readServerIdentity,
  SERVER_KEY_FILES,
} from './server-keys.js';
import {
  createTestKeyDirectory,
  type TestKeyDirectory,
} from './test-support.js';

/**
 * What the admin command line may ask of a key directory without changing it:
 * what is there (`inspectKeyDirectory`), the identity key (`readServerIdentity`)
 * and the data keys (`readDataKeyRing`). None of the three makes a file.
 */
describe('looking at a key directory without changing it', () => {
  let scratch: TestKeyDirectory;
  beforeEach(() => {
    scratch = createTestKeyDirectory();
  });
  afterEach(() => scratch.remove());

  const folder = () => join(scratch.dir, SERVER_KEY_FILES.dataKeysDirectory);
  const identityPath = () => join(scratch.dir, SERVER_KEY_FILES.identity);

  describe('inspectKeyDirectory', () => {
    it('says a directory that is not there is not there, and counts nothing', () => {
      const missing = join(scratch.dir, 'not-there');

      expect(inspectKeyDirectory(missing)).toEqual({
        exists: false,
        identityFile: false,
        dataKeyFiles: 0,
        currentFile: false,
        openFiles: process.platform === 'win32' ? null : 0,
      });
      expect(existsSync(missing)).toBe(false);
    });

    it('says an empty directory exists and holds nothing', () => {
      expect(inspectKeyDirectory(scratch.dir)).toMatchObject({
        exists: true,
        identityFile: false,
        dataKeyFiles: 0,
        currentFile: false,
      });
    });

    it('counts the identity file and the data key files, and leaves out a note, a leftover and a name that is not a key id', () => {
      loadServerKeys(scratch.dir);
      writeFileSync(join(folder(), 'README.txt'), 'a note');
      writeFileSync(join(folder(), 'current.tmp'), 'x');
      writeFileSync(join(folder(), 'not-a-uuid.key'), 'x');

      expect(inspectKeyDirectory(scratch.dir)).toMatchObject({
        exists: true,
        identityFile: true,
        dataKeyFiles: 1,
        currentFile: true,
      });
    });

    it('counts a second data key by its name, and does not read any of them', () => {
      loadServerKeys(scratch.dir);
      // A file that is not a valid key, named like one: counted by its name only.
      writeFileSync(join(folder(), `${newId()}.key`), 'garbage');

      expect(inspectKeyDirectory(scratch.dir).dataKeyFiles).toBe(2);
    });

    it('does not throw for a data-keys folder that is a file, and counts none', () => {
      writeFileSync(folder(), 'a file where a folder should be');

      expect(inspectKeyDirectory(scratch.dir)).toMatchObject({
        exists: true,
        dataKeyFiles: 0,
        currentFile: false,
      });
    });

    it.skipIf(process.platform === 'win32')(
      'counts the key files that the group or others can read, and not the directory or current',
      () => {
        loadServerKeys(scratch.dir);
        const [keyFile] = readdirSync(folder()).filter((name) =>
          name.endsWith('.key'),
        );
        expect(inspectKeyDirectory(scratch.dir).openFiles).toBe(0);

        chmodSync(identityPath(), 0o644);
        chmodSync(join(folder(), keyFile!), 0o640);
        chmodSync(join(folder(), SERVER_KEY_FILES.current), 0o644);
        chmodSync(folder(), 0o755);

        expect(inspectKeyDirectory(scratch.dir).openFiles).toBe(2);
      },
    );

    it('reports no answer for file modes on Windows, which has none to check', () => {
      loadServerKeys(scratch.dir);

      const { openFiles } = inspectKeyDirectory(scratch.dir);

      expect(openFiles === null).toBe(process.platform === 'win32');
    });
  });

  describe('readServerIdentity', () => {
    it('answers null when there is no identity file, and makes none', () => {
      expect(readServerIdentity(scratch.dir)).toBeNull();
      expect(readServerIdentity(join(scratch.dir, 'not-there'))).toBeNull();
      expect(readdirSync(scratch.dir)).toEqual([]);
    });

    it('answers the identity of the file, the same one `loadServerKeys` made', () => {
      const made = loadServerKeys(scratch.dir);

      const read = readServerIdentity(scratch.dir);

      expect(read?.publicKey).toBe(made.identity.publicKey);
      expect(read?.fingerprint).toBe(made.identity.fingerprint);
    });

    it('refuses a file that is not an identity key, with a message that holds nothing from the file', () => {
      writeFileSync(identityPath(), 'not a key at all', { mode: 0o600 });

      let caught: unknown;
      try {
        readServerIdentity(scratch.dir);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ServerKeysError);
      expect((caught as ServerKeysError).reason).toBe('invalid');
      expect((caught as ServerKeysError).message).not.toContain(
        'not a key at all',
      );
    });
  });

  describe('readDataKeyRing', () => {
    it('answers null, and makes nothing, when the data-keys folder is not there', () => {
      expect(readDataKeyRing(scratch.dir)).toBeNull();
      expect(readdirSync(scratch.dir)).toEqual([]);
    });

    it('answers the ring that `loadServerKeys` made, with the same current key', () => {
      const made = loadServerKeys(scratch.dir);

      const ring = readDataKeyRing(scratch.dir);

      expect(ring?.currentKeyId).toBe(made.dataKeys.currentKeyId);
      const sealed = made.dataKeys.encrypt('a value', 'row:1');
      expect(ring?.decrypt(sealed, 'row:1')).toBe('a value');
    });

    it('answers null when current is missing, or names a key file that is not there, even with key files in the folder', () => {
      loadServerKeys(scratch.dir);
      const current = join(folder(), SERVER_KEY_FILES.current);
      const keyFile = readdirSync(folder()).find((name) =>
        name.endsWith('.key'),
      )!;

      writeFileSync(current, '0198c1c0-0000-7000-8000-000000000000\n');
      expect(readDataKeyRing(scratch.dir)).toBeNull();

      rmSync(current);
      expect(readDataKeyRing(scratch.dir)).toBeNull();
      // Nothing was made, and the key file is untouched.
      expect(existsSync(join(folder(), keyFile))).toBe(true);
      expect(readdirSync(folder()).sort()).toEqual([keyFile]);
    });

    it('refuses a current that is not a key id, and a key file that is not a key', () => {
      loadServerKeys(scratch.dir);
      const current = join(folder(), SERVER_KEY_FILES.current);
      writeFileSync(current, 'not-a-key-id\n');
      expect(() => readDataKeyRing(scratch.dir)).toThrow(ServerKeysError);

      const keyFile = readdirSync(folder()).find((name) =>
        name.endsWith('.key'),
      )!;
      writeFileSync(current, `${keyFile.replace('.key', '')}\n`);
      writeFileSync(join(folder(), keyFile), 'garbage\n', { mode: 0o600 });
      expect(() => readDataKeyRing(scratch.dir)).toThrow(
        expect.objectContaining({ reason: 'invalid' }) as Error,
      );
    });

    it('does not make the directory it is asked about', () => {
      const missing = join(scratch.dir, 'a', 'b');

      expect(readDataKeyRing(missing)).toBeNull();
      expect(existsSync(join(scratch.dir, 'a'))).toBe(false);
    });
  });
});
