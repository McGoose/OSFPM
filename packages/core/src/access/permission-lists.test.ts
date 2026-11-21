import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPLIANCE_REPORT_PERMISSION } from '../sensitive/permissions.js';
import { PERMISSION_LISTS } from './permission-lists.js';

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
