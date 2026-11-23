import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A profile ends in two ways only (decision D-69, carry-over B of P-02l2): the person deletes
 * it (`deleteAccessProfile`), or their account is deleted (`endAccountAccessSharing`). Nothing
 * deletes one because time has passed. Both go through `deleteProfileRow`, which is the one
 * place the table is deleted from, so this scans the source for a delete of the table
 * anywhere else and for any other caller of that function: a purge job, a cleanup or a new
 * path would have to be one of the two or fail here. Tests and test-support files are
 * skipped, because fixtures may write rows directly.
 */

/** The one file that deletes from the profile table, and holds `deleteProfileRow`. */
const DELETER = 'core/src/sensitive/access-profile.ts';

/** The files that call `deleteProfileRow`: the person's deletion, and the account's. */
const CALLERS = [DELETER, 'core/src/sensitive/account-sharing.ts'];

/** A Drizzle delete of the table, or raw SQL that deletes from it. */
const DELETES_PROFILE =
  /\.delete\(\s*(?:[\w$]+\.)*userAccessProfile\s*[,)]|delete\s+from\s+"?user_access_profile"?(?![\w])/i;

/** A mention of the function that does it. */
const NAMES_DELETE_ROW = /\bdeleteProfileRow\b/;

/** Files only tests import. */
const TEST_ONLY_FILE = /(?:\.test|^test-support|^test-fixtures)\.ts$/;

/** The non-test source files under `root`, as paths relative to it with forward slashes. */
function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !TEST_ONLY_FILE.test(entry.name),
    )
    .map((entry) =>
      relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'),
    )
    .filter((path) => !path.split('/').includes('node_modules'))
    .sort();
}

/** The files under `root` whose text matches `pattern`, outside the `allowed` paths. */
function outside(
  root: string,
  pattern: RegExp,
  allowed: readonly string[],
): string[] {
  return sourceFiles(root).filter(
    (path) =>
      !allowed.includes(path) &&
      pattern.test(readFileSync(join(root, path), 'utf8')),
  );
}

const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url));

describe('the ways an access profile ends', () => {
  it('finds the source it is meant to scan', () => {
    // Guards against scanning the wrong folder and passing for nothing.
    const files = sourceFiles(PACKAGES);
    expect(files.length).toBeGreaterThan(30);
    expect(files).toEqual(expect.arrayContaining(CALLERS));
  });

  it('are two: the profile table is deleted from in one place', () => {
    expect(outside(PACKAGES, DELETES_PROFILE, [DELETER])).toEqual([]);
    expect(
      readFileSync(join(PACKAGES, DELETER), 'utf8'),
      'the one place is the one the scan allows',
    ).toMatch(DELETES_PROFILE);
  });

  it('are the person deleting it and the account being deleted: nothing else calls that place', () => {
    expect(outside(PACKAGES, NAMES_DELETE_ROW, CALLERS)).toEqual([]);
    for (const path of CALLERS) {
      expect(readFileSync(join(PACKAGES, path), 'utf8'), path).toMatch(
        NAMES_DELETE_ROW,
      );
    }
  });

  it('catches a purge by age, a second delete and a new caller', () => {
    const root = mkdtempSync(join(tmpdir(), 'osfpm-erasure-'));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write(DELETER, 'await tx.delete(userAccessProfile).where(x);');
      write(
        'core/src/sensitive/account-sharing.ts',
        'await deleteProfileRow(tx, userId);',
      );
      write(
        'core/src/retention/purge.ts',
        'await tx.delete(schema.userAccessProfile).where(old);',
      );
      write(
        'core/src/sensitive/purge-by-age.ts',
        'await deleteProfileRow(tx, userId);',
      );
      write(
        'core/src/costs/raw.ts',
        'await tx.execute(sql`delete from "user_access_profile" where x`);',
      );
      write(
        'core/src/sensitive/read.ts',
        'await tx.select().from(userAccessProfile);',
      );
      write(
        'core/src/sensitive/purge.test.ts',
        'await tx.delete(userAccessProfile).where(x);',
      );
      write(
        'api/node_modules/dep/index.ts',
        'await tx.delete(userAccessProfile);',
      );
      expect(outside(root, DELETES_PROFILE, [DELETER])).toEqual([
        'core/src/costs/raw.ts',
        'core/src/retention/purge.ts',
      ]);
      expect(outside(root, NAMES_DELETE_ROW, CALLERS)).toEqual([
        'core/src/sensitive/purge-by-age.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
