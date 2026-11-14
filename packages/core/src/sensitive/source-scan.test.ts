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

/** Where `person_sensitive` may be named: the definition, the schema index, and the sensitive module. */
const ALLOWED = [
  'core/src/sensitive/',
  'core/src/db/schema/index.ts',
  'core/src/db/schema/person-sensitive.ts',
];

/** The Drizzle table's identifier, or the module that defines it. */
const TABLE_REFERENCE = /\bpersonSensitive\b|person-sensitive(?:\.js)?['"]/;

function typescriptFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(
      (file) => !relative(root, file).split(sep).includes('node_modules'),
    );
}

/** Files under `root` (relative, forward slashes) that use the table without being allowed to. */
function violations(root: string): string[] {
  return typescriptFiles(root)
    .map((file) => relative(root, file).split(sep).join('/'))
    .filter((path) => !ALLOWED.some((a) => path === a || path.startsWith(a)))
    .filter((path) =>
      TABLE_REFERENCE.test(readFileSync(join(root, path), 'utf8')),
    );
}

const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url));

describe('who may use the person_sensitive table', () => {
  it('is only the sensitive module and the schema definition', () => {
    const files = typescriptFiles(PACKAGES);
    // Guards against scanning nothing and passing for nothing.
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.endsWith(join('sensitive', 'service.ts')))).toBe(
      true,
    );
    expect(violations(PACKAGES)).toEqual([]);
  });

  it('catches an outside file that imports or names the table', () => {
    const root = mkdtempSync(join(tmpdir(), 'osfpm-scan-'));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write(
        'core/src/sensitive/service.ts',
        "import { personSensitive } from '../db/schema/index.js';",
      );
      write(
        'core/src/db/schema/index.ts',
        "export * from './person-sensitive.js';",
      );
      write(
        'core/src/other.ts',
        "import { personSensitive } from './db/schema/index.js';",
      );
      write(
        'api/src/direct.ts',
        "import * as t from '../core/db/schema/person-sensitive.js';",
      );
      write('api/src/namespaced.ts', 'const x = schema.personSensitive;');
      write(
        'api/src/fine.ts',
        "const note = 'person_sensitive is a table name';",
      );
      write('api/node_modules/dep/index.ts', 'const personSensitive = 1;');
      expect(violations(root).sort()).toEqual([
        'api/src/direct.ts',
        'api/src/namespaced.ts',
        'core/src/other.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
