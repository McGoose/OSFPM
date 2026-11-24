import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPLIANCE_REPORT_PERMISSION } from '../sensitive/permissions.js';
import { PERMISSION_LISTS } from './permission-lists.js';
import {
  PERMISSION_ACCESS,
  type PermissionDefinition,
} from './permission-sync.js';

/** The core's `src` folder. */
const CORE_SRC = fileURLToPath(new URL('../', import.meta.url));

/**
 * Every permission list a file of the core declares, as its export name and
 * file. Read from the source text, so a list that a module adds is found without
 * anyone remembering to tell this test.
 */
function declaredLists(): { file: string; name: string }[] {
  return readdirSync(CORE_SRC, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts'),
    )
    .flatMap((entry) => {
      const file = join(entry.parentPath, entry.name);
      const text = readFileSync(file, 'utf8');
      return [
        ...text.matchAll(
          /^export const (\w+): readonly PermissionDefinition\[\]/gm,
        ),
      ].map((match) => ({ file, name: match[1]! }));
    });
}

/**
 * The keys that end in `:read` and are classed `write` with no `accessReason`
 * (blank counts as none). A key that says read and is classed write is the likeliest
 * slip when a permission is added, so it must say why (maintainer decision, P-03b5).
 */
function readKeysClassedWriteWithoutReason(
  definitions: readonly PermissionDefinition[],
): string[] {
  return definitions
    .filter(
      (entry) =>
        entry.key.endsWith(':read') &&
        entry.access === 'write' &&
        (entry.accessReason ?? '').trim() === '',
    )
    .map((entry) => entry.key)
    .sort();
}

describe('PERMISSION_LISTS', () => {
  it('holds every permission list that a module of the core declares, and nothing else', async () => {
    const declared = declaredLists();
    // Guards against scanning the wrong folder and passing for nothing.
    expect(declared.length).toBeGreaterThan(3);
    for (const { file, name } of declared) {
      const exported = (await import(pathToFileURL(file).href)) as Record<
        string,
        unknown
      >;
      expect(
        PERMISSION_LISTS,
        `${name} is declared but not in PERMISSION_LISTS: add it to access/permission-lists.ts, or it is never synced at start-up`,
      ).toContain(exported[name]);
    }
    expect(PERMISSION_LISTS).toHaveLength(declared.length);
  });

  it('lists no list twice', () => {
    expect(new Set(PERMISSION_LISTS).size).toBe(PERMISSION_LISTS.length);
  });

  it('declares no key twice, because two lists would take turns at flagging it on every start', () => {
    const keys = PERMISSION_LISTS.flatMap((list) =>
      list.map((entry) => entry.key),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  // A personal API token that can only read is refused every permission that is
  // not classed `read` (decision of 23 Nov, task P-03b5), so a permission with no
  // class would be a hole in that rule. The field is required by the type; this
  // is the check for a value that got past it.
  it('classes every permission as read or write', () => {
    // Guards against the lists being empty and the loop passing for nothing.
    expect(PERMISSION_LISTS.flat().length).toBeGreaterThan(10);
    for (const entry of PERMISSION_LISTS.flat()) {
      expect(PERMISSION_ACCESS, entry.key).toContain(entry.access);
    }
  });

  it('classes a key that ends in :read as write only when its definition says why', () => {
    expect(readKeysClassedWriteWithoutReason(PERMISSION_LISTS.flat())).toEqual(
      [],
    );
  });

  it('finds a :read key classed write with no reason, and nothing else', () => {
    const entry = (
      key: string,
      access: PermissionDefinition['access'],
      accessReason?: string,
    ): PermissionDefinition => ({
      key,
      module: 'budget',
      description: key,
      access,
      ...(accessReason === undefined ? {} : { accessReason }),
    });
    expect(
      readKeysClassedWriteWithoutReason([
        entry('budget:read', 'write'),
        entry('budget:read', 'write', '   '),
        entry('forecast:read', 'write', ''),
        // Not flagged: said why, classed read, or the key does not end in :read.
        entry('lines:read', 'write', 'It also exports the lines to the bank.'),
        entry('notes:read', 'read'),
        entry('notes:edit', 'write'),
        entry('notes:read-value', 'write'),
        entry('sensitive:read:medical', 'write'),
      ]),
    ).toEqual(['budget:read', 'budget:read', 'forecast:read']);
  });

  // `contracts:read-value` shows the amount of a contract and also sets it, so it
  // is write for now: a read token cannot hold it (maintainer decision, P-03b5).
  it('classes contracts:read-value as write, with the reason in its definition', () => {
    const found = PERMISSION_LISTS.flat().find(
      (entry) => entry.key === 'contracts:read-value',
    );
    expect(found).toMatchObject({ access: 'write' });
    expect((found?.accessReason ?? '').trim().length).toBeGreaterThan(0);
  });

  it('classes the plain read and edit keys the way their names say', () => {
    const classOf = new Map(
      PERMISSION_LISTS.flat().map((entry) => [entry.key, entry.access]),
    );
    for (const key of [
      'accounts:read',
      'companies:read',
      'contracts:read',
      'costs:read',
      'locations:read',
      'members:read',
      'people:read',
      'compliance:report',
      'sensitive:read:medical',
    ]) {
      expect(classOf.get(key), key).toBe('read');
    }
    for (const key of [
      'accounts:edit',
      'companies:edit',
      'contracts:edit',
      'costs:edit',
      'costs:tag-schemes',
      'legal-hold:manage',
      'locations:edit',
      'members:invite',
      'members:reset-access',
      'people:edit',
      'sensitive:edit:medical',
      'api:manage',
      'api:tokens',
    ]) {
      expect(classOf.get(key), key).toBe('write');
    }
  });

  it('flags every key under sensitive: as sensitive, and the count-only compliance report as not (CLAUDE.md, Privacy rule)', () => {
    const definitions = PERMISSION_LISTS.flat();
    for (const entry of definitions) {
      if (entry.key.startsWith('sensitive:')) {
        expect(entry.grantsSensitive, entry.key).toBe(true);
      }
    }
    expect(
      definitions.find((entry) => entry.key === COMPLIANCE_REPORT_PERMISSION)
        ?.grantsSensitive,
    ).toBe(false);
  });
});
