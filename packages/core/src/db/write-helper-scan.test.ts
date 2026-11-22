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
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  securityChildTables,
  securityTableNames,
  tenantTableNames,
} from './columns.js';
import * as schemaModule from './schema/index.js';

/**
 * CLAUDE.md, Data rules: tenant records are written only through the write
 * helper, tables in `SECURITY_TABLES` only by the auth service, and the tables
 * in `SERVICE_WRITTEN_TABLES` (`user`, `installation`) only by the services
 * named for them. This scans the source for a Drizzle write that names such a
 * table outside the places allowed to. The sets of tables, and the services
 * named for the last kind, come from the schema, not from a list kept here.
 *
 * It sees `.insert(x)`, `.update(x)` and `.delete(x)` where `x` is the table's
 * exported identifier, and raw SQL that names the table. Tests and test-support
 * files are skipped: fixtures may insert rows directly to set up state.
 */

/** Where tenant tables may be written: the write helper itself. */
const WRITE_HELPER = ['core/src/db/write.ts'];
/** Where security tables may be written: the auth service. */
const AUTH_SERVICE = ['core/src/auth/'];

/** Files only tests import. Fixtures insert rows directly to set up state. */
const TEST_ONLY_FILE = /(?:\.test|^test-support|^test-fixtures)\.ts$/;

function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !TEST_ONLY_FILE.test(entry.name),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(
      (file) => !relative(root, file).split(sep).includes('node_modules'),
    );
}

type Table = { identifier: string; name: string };

/** Schema exports that are tables of `names`, as exported identifier and table name. */
function tablesNamed(names: ReadonlySet<string>): Table[] {
  return Object.entries(schemaModule)
    .flatMap(([identifier, value]) =>
      is(value, PgTable) ? [{ identifier, name: getTableName(value) }] : [],
    )
    .filter((table) => names.has(table.name));
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Files under `root` that write one of `tables`, outside the `allowed` paths. */
function violations(
  root: string,
  tables: Table[],
  allowed: readonly string[],
): string[] {
  const identifiers = new Set(tables.map((table) => table.identifier));
  const sqlWrite = new RegExp(
    `\\b(?:insert\\s+into|update|delete\\s+from)\\s+"?(?:${tables
      .map((table) => escape(table.name))
      .join('|')})"?(?![\\w])`,
    'i',
  );
  // `.insert(costLine)`, `.update(schema.costLine)`, `.delete(costLine, ...)`.
  const drizzleWrite =
    /\.(?:insert|update|delete)\(\s*(?:[\w$]+\.)*([\w$]+)\s*[,)]/g;
  return sourceFiles(root)
    .map((file) => relative(root, file).split(sep).join('/'))
    .filter((path) => !allowed.some((a) => path === a || path.startsWith(a)))
    .filter((path) => {
      const text = readFileSync(join(root, path), 'utf8');
      const named = [...text.matchAll(drizzleWrite)].some((m) =>
        identifiers.has(m[1]!),
      );
      return named || sqlWrite.test(text);
    })
    .sort();
}

const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url));

describe('who may write tenant and security tables', () => {
  const tenant = tablesNamed(tenantTableNames());
  const security = tablesNamed(securityTableNames());
  const securityChildren = tablesNamed(new Set(securityChildTables().keys()));

  it('finds the tables and the source it is meant to check', () => {
    // Guards against the scan matching nothing and passing for nothing.
    expect(tenant.length).toBeGreaterThanOrEqual(20);
    expect(security.length).toBeGreaterThanOrEqual(6);
    expect(securityChildren.length).toBeGreaterThanOrEqual(1);
    const files = sourceFiles(PACKAGES).map((file) =>
      relative(PACKAGES, file).split(sep).join('/'),
    );
    expect(files).toEqual(expect.arrayContaining(['core/src/db/write.ts']));
  });

  it('writes tenant tables only through the write helper', () => {
    expect(violations(PACKAGES, tenant, WRITE_HELPER)).toEqual([]);
  });

  it('writes security tables only in the auth service', () => {
    expect(violations(PACKAGES, security, AUTH_SERVICE)).toEqual([]);
  });

  // A child table of a security table (invite_role) has an organisation_id like a
  // tenant table, but it is the auth service's, not the write helper's.
  it('writes the child tables of security tables only in the auth service', () => {
    expect(violations(PACKAGES, securityChildren, AUTH_SERVICE)).toEqual([]);
  });

  describe('user and installation', () => {
    const entries = schemaModule.SERVICE_WRITTEN_TABLES.map((entry) => ({
      name: getTableName(entry.table),
      table: entry.table,
      allowed: entry.services.map((service) => `core/src/${service}/`),
    }));

    it('are the two tables the Data rule names', () => {
      // The names in CLAUDE.md. A third table needs the rule changed too.
      expect(entries.map((entry) => entry.name).sort()).toEqual([
        'installation',
        'user',
      ]);
      for (const entry of entries) {
        expect(tablesNamed(new Set([entry.name])), entry.name).toHaveLength(1);
      }
    });

    it('are install-level: no organisation_id, so never a tenant table, a security table, or one the write helper takes', () => {
      for (const entry of entries) {
        const columns = getTableConfig(entry.table).columns.map((c) => c.name);
        expect(columns, entry.name).not.toContain('organisation_id');
        expect(tenantTableNames().has(entry.name), entry.name).toBe(false);
        expect(securityTableNames().has(entry.name), entry.name).toBe(false);
      }
    });

    it('are written only by services that exist, and each has source files', () => {
      const files = sourceFiles(PACKAGES).map((file) =>
        relative(PACKAGES, file).split(sep).join('/'),
      );
      for (const entry of entries) {
        expect(entry.allowed.length, entry.name).toBeGreaterThan(0);
        for (const folder of entry.allowed) {
          expect(
            files.some((file) => file.startsWith(folder)),
            `${entry.name} names ${folder}, which has no source files`,
          ).toBe(true);
        }
      }
    });

    it.each(entries.map((entry) => [entry.name, entry] as const))(
      'writes %s only in the services named for it',
      (name, entry) => {
        expect(
          violations(PACKAGES, tablesNamed(new Set([name])), entry.allowed),
        ).toEqual([]);
      },
    );

    it('catches a write to either table outside the named services', () => {
      const root = mkdtempSync(join(tmpdir(), 'osfpm-write-scan-'));
      try {
        const write = (path: string, text: string) => {
          mkdirSync(dirname(join(root, path)), { recursive: true });
          writeFileSync(join(root, path), text);
        };
        write('core/src/auth/sessions.ts', 'await tx.update(user).set(x);');
        write(
          'core/src/projects/oops.ts',
          'await tx.update(user).set({ status: x });',
        );
        // A service that is not named (yet) may not write `installation`.
        write(
          'core/src/setup/later.ts',
          'await tx.update(installation).set(x);',
        );
        write(
          'core/src/costs/raw.ts',
          'await tx.execute(sql`update "user" set x = 1`);',
        );
        write('core/src/costs/read.ts', 'await tx.select().from(user);');
        write(
          'core/src/access/test-fixtures.ts',
          'await tx.insert(user).values(row);',
        );
        const tables = [
          { identifier: 'user', name: 'user' },
          { identifier: 'installation', name: 'installation' },
        ];
        expect(violations(root, tables, ['core/src/auth/'])).toEqual([
          'core/src/costs/raw.ts',
          'core/src/projects/oops.ts',
          'core/src/setup/later.ts',
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('catches a file that writes a table outside its allowed place', () => {
    const root = mkdtempSync(join(tmpdir(), 'osfpm-write-scan-'));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write('core/src/db/write.ts', 'await tx.insert(costLine).values(row);');
      write(
        'core/src/auth/sessions.ts',
        'await tx.insert(session).values(row);',
      );
      write(
        'core/src/costs/direct.ts',
        'await tx.insert(costLine).values(row);',
      );
      write(
        'core/src/costs/namespaced.ts',
        'await tx.update(schema.costLine).set(x);',
      );
      write(
        'core/src/costs/raw.ts',
        'await tx.execute(sql`delete from cost_line`);',
      );
      write('core/src/costs/read.ts', 'await tx.select().from(costLine);');
      write(
        'core/src/costs/direct.test.ts',
        'await tx.insert(costLine).values(row);',
      );
      write(
        'core/src/access/test-fixtures.ts',
        'await tx.insert(role).values(row);',
      );
      write('api/src/leak.ts', 'await tx.delete(session).where(x);');
      write(
        'api/node_modules/dep/index.ts',
        'await tx.insert(costLine).values(r);',
      );
      const costLine = { identifier: 'costLine', name: 'cost_line' };
      const session = { identifier: 'session', name: 'session' };
      expect(violations(root, [costLine], WRITE_HELPER)).toEqual([
        'core/src/costs/direct.ts',
        'core/src/costs/namespaced.ts',
        'core/src/costs/raw.ts',
      ]);
      expect(violations(root, [session], AUTH_SERVICE)).toEqual([
        'api/src/leak.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
