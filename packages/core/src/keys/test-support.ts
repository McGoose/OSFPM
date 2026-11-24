import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { loadServerKeys, type ServerKeys } from './server-keys.js';

/** A throwaway key directory and the call that deletes it. Only tests use it. */
export type TestKeyDirectory = {
  /** The directory, empty and not yet holding any key. */
  readonly dir: string;
  /** Deletes the directory and everything in it. Safe to call twice. */
  readonly remove: () => void;
};

/**
 * Makes an empty directory under the system's temporary directory, named for the
 * tests, to hold server keys for one test or one test file. The caller deletes it
 * with `remove`. Only tests import this file.
 */
export function createTestKeyDirectory(): TestKeyDirectory {
  const dir = mkdtempSync(join(tmpdir(), 'osfpm-test-keys-'));
  return {
    dir,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * For one test file: makes a key directory before its tests, loads the server
 * keys from it (creating them), and deletes the directory after the last test.
 * Call it once, at the top of the file or of a `describe`; the returned function
 * gives the keys inside a test or a hook. Only tests import this file.
 */
export function useTestServerKeys(): () => ServerKeys {
  let directory: TestKeyDirectory | undefined;
  let keys: ServerKeys | undefined;
  beforeAll(() => {
    directory = createTestKeyDirectory();
    keys = loadServerKeys(directory.dir);
  });
  afterAll(() => {
    directory?.remove();
  });
  return () => {
    if (keys === undefined) {
      throw new Error('The test server keys are used before beforeAll ran');
    }
    return keys;
  };
}
