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
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { tableWriters } from '../db/columns.js';
import * as schemaModule from '../db/schema/index.js';

/**
 * The one door (CLAUDE.md, Data rules): only the sensitive module names the tables that
 * hold crew personal data. They are `person_sensitive`, and every table whose declared
 * writer is the sensitive service (`tableWriters`): the account-level access profile
 * and the access grants (decision D-69). Reading is one door too: the module is the only
 * code that imports them, so access rules and audit live in one place.
 */

/** The tables behind the door, as table name, exported identifier and module file name. */
type DoorTable = { name: string; identifier: string; module: string };

/** `person_sensitive` is a tenant table, so the registry of writers does not name it. */
const TENANT_DOOR_TABLES = ['person_sensitive'];

/** The tables the registry says the sensitive service writes. */
function sensitiveWriterTables(): string[] {
  return [...tableWriters()]
    .filter(([, writer]) => writer.service === 'sensitive')
    .map(([name]) => name);
}

/** The tables behind the door, found in the schema by name. */
function doorTables(): DoorTable[] {
  const names = new Set([...TENANT_DOOR_TABLES, ...sensitiveWriterTables()]);
  return Object.entries(schemaModule)
    .flatMap(([identifier, value]) =>
      is(value, PgTable) && names.has(getTableName(value))
        ? [
            {
              name: getTableName(value),
              identifier,
              // The files of `db/schema/` are named after their table, with hyphens.
              module: getTableName(value).replaceAll('_', '-'),
            },
          ]
        : [],
    )
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Where the tables may be named besides the sensitive module: the schema index, the two
 * lists that declare the tables (`SECURITY_TABLES`, `SERVICE_WRITTEN_TABLES`) and each
 * table's own definition.
 */
function allowedFor(tables: readonly DoorTable[]): string[] {
  return [
    'core/src/sensitive/',
    'core/src/db/schema/index.ts',
    'core/src/db/schema/security-tables.ts',
    'core/src/db/schema/service-written-tables.ts',
    ...tables.map((table) => `core/src/db/schema/${table.module}.ts`),
  ];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The Drizzle table's identifier, or the module that defines it, for any of `tables`. */
function referenceTo(tables: readonly DoorTable[]): RegExp {
  const identifiers = tables.map((table) => escape(table.identifier));
  const modules = tables.map((table) => escape(table.module));
  return new RegExp(
    `\\b(?:${identifiers.join('|')})\\b|(?:${modules.join('|')})(?:\\.js)?['"]`,
  );
}

function typescriptFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(
      (file) => !relative(root, file).split(sep).includes('node_modules'),
    );
}

/** Files under `root` (relative, forward slashes) that use one of the tables without being allowed to. */
function violations(root: string, tables: readonly DoorTable[]): string[] {
  const allowed = allowedFor(tables);
  const reference = referenceTo(tables);
  return typescriptFiles(root)
    .map((file) => relative(root, file).split(sep).join('/'))
    .filter((path) => !allowed.some((a) => path === a || path.startsWith(a)))
    .filter((path) => reference.test(readFileSync(join(root, path), 'utf8')));
}

const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url));

describe('who may use the tables behind the sensitive door', () => {
  it('are person_sensitive and the tables the sensitive service writes, found from the registry', () => {
    // The tables the Data rule names. A new one needs the rule changed too.
    expect(doorTables().map((table) => table.name)).toEqual([
      'access_grant',
      'person_sensitive',
      'user_access_profile',
    ]);
    expect(doorTables().map((table) => table.module)).toEqual([
      'access-grant',
      'person-sensitive',
      'user-access-profile',
    ]);
  });

  it('is only the sensitive module and the schema definitions', () => {
    const files = typescriptFiles(PACKAGES);
    // Guards against scanning nothing and passing for nothing.
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.endsWith(join('sensitive', 'service.ts')))).toBe(
      true,
    );
    expect(violations(PACKAGES, doorTables())).toEqual([]);
  });

  it('catches an outside file that imports or names a table', () => {
    const root = mkdtempSync(join(tmpdir(), 'osfpm-scan-'));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write(
        'core/src/sensitive/service.ts',
        "import { personSensitive, accessGrant } from '../db/schema/index.js';",
      );
      write(
        'core/src/db/schema/index.ts',
        "export * from './person-sensitive.js';",
      );
      write(
        'core/src/db/schema/security-tables.ts',
        "import { accessGrant } from './access-grant.js';",
      );
      write(
        'core/src/other.ts',
        "import { personSensitive } from './db/schema/index.js';",
      );
      write(
        'core/src/auth/grants.ts',
        "import { accessGrant } from '../db/schema/index.js';",
      );
      write(
        'api/src/direct.ts',
        "import * as t from '../core/db/schema/person-sensitive.js';",
      );
      write(
        'api/src/profile.ts',
        "import { userAccessProfile } from '../core/db/schema/user-access-profile.js';",
      );
      write('api/src/namespaced.ts', 'const x = schema.personSensitive;');
      write(
        'api/src/fine.ts',
        "const note = 'person_sensitive and access_grant are table names';",
      );
      write('api/node_modules/dep/index.ts', 'const personSensitive = 1;');
      expect(violations(root, doorTables()).sort()).toEqual([
        'api/src/direct.ts',
        'api/src/namespaced.ts',
        'api/src/profile.ts',
        'core/src/auth/grants.ts',
        'core/src/other.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
