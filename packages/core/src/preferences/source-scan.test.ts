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
 * Who may read a person's delivery preferences (decision D-69, P-02l2): the person, staff
 * who hold `people:edit`, and system code through `effectivePreferences`, and nothing else.
 * They are kept in two places, `user_preferences` and the `communication_preferences` column
 * of `person`, so only the preferences module may name either. An ordinary read of a person
 * therefore never carries them: no other code reads the column by name, and a read of a
 * person lists the columns it wants (a read that selected the whole row would not name the
 * column, which is why the schema comment and the module README say so). Tests and test
 * support are skipped, because fixtures set up state directly.
 */

/** The names of the two places, as the identifiers the schema exports and as table and column names. */
const PLACES =
  /\b(?:userPreferences|communicationPreferences|user_preferences|communication_preferences)\b|user-preferences(?:\.js)?['"]/;

/**
 * Where the places may be named besides the preferences module: the schema index, the list
 * that declares the writer, and the two definitions.
 */
const ALLOWED = [
  'core/src/preferences/',
  'core/src/db/schema/index.ts',
  'core/src/db/schema/service-written-tables.ts',
  'core/src/db/schema/person.ts',
  'core/src/db/schema/user-preferences.ts',
];

/** Files only tests import. */
const TEST_ONLY_FILE = /(?:\.test|^test-support|^test-fixtures)\.ts$/;

/** The non-test source files under `root`, as paths relative to it with forward slashes. */
function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(ts|tsx|mts|cts)$/.test(entry.name) &&
        !TEST_ONLY_FILE.test(entry.name),
    )
    .map((entry) =>
      relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'),
    )
    .filter((path) => !path.split('/').includes('node_modules'))
    .sort();
}

/** The files under `root` outside the allowed places that name one of the two. */
function violations(root: string): string[] {
  return sourceFiles(root).filter(
    (path) =>
      !ALLOWED.some((place) => path === place || path.startsWith(place)) &&
      PLACES.test(readFileSync(join(root, path), 'utf8')),
  );
}

const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url));

describe('who may name the places delivery preferences are kept', () => {
  it('is only the preferences module and the schema definitions', () => {
    const files = sourceFiles(PACKAGES);
    // Guards against scanning the wrong folder and passing for nothing.
    expect(files.length).toBeGreaterThan(30);
    expect(files).toEqual(
      expect.arrayContaining(['core/src/preferences/service.ts']),
    );
    expect(violations(PACKAGES)).toEqual([]);
  });

  it('finds the module’s own use of both places, so the scan is looking at the right names', () => {
    const service = readFileSync(
      join(PACKAGES, 'core/src/preferences/service.ts'),
      'utf8',
    );
    expect(service).toMatch(/\buserPreferences\b/);
    expect(service).toMatch(/\bcommunicationPreferences\b/);
  });

  it('catches an outside file that names either place, by identifier, by import or in raw SQL', () => {
    const root = mkdtempSync(join(tmpdir(), 'osfpm-prefs-scan-'));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write(
        'core/src/preferences/service.ts',
        'const x = person.communicationPreferences;',
      );
      write(
        'core/src/db/schema/index.ts',
        "export * from './user-preferences.js';",
      );
      write(
        'core/src/db/schema/person.ts',
        "communicationPreferences: jsonb('communication_preferences'),",
      );
      write(
        'core/src/members/list.ts',
        'const rows = await tx.select({ prefs: person.communicationPreferences }).from(person);',
      );
      write(
        'core/src/email/direct.ts',
        "import { userPreferences } from '../db/schema/index.js';",
      );
      write(
        'api/src/direct.ts',
        "import * as t from '../core/db/schema/user-preferences.js';",
      );
      write(
        'core/src/costs/raw.ts',
        'await tx.execute(sql`select payload from user_preferences`);',
      );
      write(
        'core/src/projects/raw.ts',
        'await tx.execute(sql`select communication_preferences from person`);',
      );
      write(
        'core/src/members/fine.ts',
        "const note = 'the preferences are read through effectivePreferences';",
      );
      write(
        'core/src/members/direct.test.ts',
        'await tx.select().from(userPreferences);',
      );
      write('api/node_modules/dep/index.ts', 'const userPreferences = 1;');
      expect(violations(root)).toEqual([
        'api/src/direct.ts',
        'core/src/costs/raw.ts',
        'core/src/email/direct.ts',
        'core/src/members/list.ts',
        'core/src/projects/raw.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
