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

type Found = {
  /** Path under the scanned root, with forward slashes. */
  readonly file: string;
  readonly line: number;
  /** The declared name, or the text of an export this scan does not understand. */
  readonly name: string;
  readonly problem: string | null;
};

/** A top-level declaration that needs a JSDoc. */
const DECLARATION =
  /^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|const|let|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/;

/** `export *`, `export * as x`, `export { a }` and `export type { A }` declare nothing. */
const RE_EXPORT = /^export\s+(?:type\s+)?[*{]/;

function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !relative(root, file).split(sep).includes('node_modules'))
    .sort();
}

/** The block comment that ends on the line above `index`, or null if there is none. */
function commentAbove(lines: string[], index: number): string | null {
  if (!(lines[index - 1] ?? '').trim().endsWith('*/')) return null;
  for (let start = index - 1; start >= 0; start -= 1) {
    const line = lines[start]!;
    // Another comment closes above this one: the `*/` was not ours.
    if (start < index - 1 && line.includes('*/')) return null;
    if (line.includes('/*')) {
      return line.trim().startsWith('/**')
        ? lines.slice(start, index).join('\n')
        : null;
    }
  }
  return null;
}

/** True when a JSDoc block holds no words, such as `/** *\/`. */
function isEmptyJsdoc(block: string): boolean {
  return (
    block
      .replace(/^\s*\/\*+/, '')
      .replace(/\*+\/\s*$/, '')
      .split('\n')
      .map((line) => line.replace(/^\s*\*+\s?/, '').trim())
      .join('')
      .trim() === ''
  );
}

/**
 * Every top-level export in the non-test `.ts` files under `root`, with what is
 * wrong with its JSDoc, if anything. An export that is not a recognised
 * declaration or re-export is reported rather than skipped, so a new form
 * cannot slip through unchecked.
 */
function scanExports(root: string): Found[] {
  const found: Found[] = [];
  for (const path of sourceFiles(root)) {
    const file = relative(root, path).split(sep).join('/');
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    const functions = new Set<string>();
    lines.forEach((text, i) => {
      if (!/^export\b/.test(text) || RE_EXPORT.test(text)) return;
      const line = i + 1;
      const declaration = DECLARATION.exec(text);
      if (!declaration) {
        found.push({
          file,
          line,
          name: text.trim(),
          problem: 'unrecognised export form',
        });
        return;
      }
      const [, kind, name] = declaration as unknown as [string, string, string];
      // Overloads and their implementation are one function: the first
      // signature carries the JSDoc.
      if (kind.startsWith('function')) {
        if (functions.has(name)) return;
        functions.add(name);
      }
      const block = commentAbove(lines, i);
      found.push({
        file,
        line,
        name,
        problem:
          block === null
            ? 'no JSDoc'
            : isEmptyJsdoc(block)
              ? 'empty JSDoc'
              : null,
      });
    });
  }
  return found;
}

/** Every export without a usable JSDoc, as `file:line name: problem`. */
const problems = (root: string) =>
  scanExports(root)
    .filter((found) => found.problem !== null)
    .map(
      (found) => `${found.file}:${found.line} ${found.name}: ${found.problem}`,
    );

const SRC = fileURLToPath(new URL('.', import.meta.url));
const API_SRC = fileURLToPath(new URL('../../api/src/', import.meta.url));

describe('JSDoc on every export in the packages', () => {
  it('has a JSDoc on every export in packages/core/src', () => {
    const found = scanExports(SRC);
    // Guards against scanning the wrong folder and passing for nothing.
    expect(
      found.some((f) => f.file === 'db/write.ts' && f.name === 'insertRecord'),
    ).toBe(true);
    expect(problems(SRC)).toEqual([]);
  });

  // One scan for every package, so the rule has one definition. The core's
  // tests reach into the API's folder rather than copy the scan.
  it('has a JSDoc on every export in packages/api/src', () => {
    const found = scanExports(API_SRC);
    // Guards against scanning the wrong folder and passing for nothing.
    expect(
      found.some((f) => f.file === 'api-version.ts' && f.name === 'API_PREFIX'),
    ).toBe(true);
    expect(problems(API_SRC)).toEqual([]);
  });

  describe('the scan itself', () => {
    function inTempTree(
      files: Record<string, string>,
      check: (root: string) => void,
    ) {
      const root = mkdtempSync(join(tmpdir(), 'osfpm-jsdoc-'));
      try {
        for (const [path, text] of Object.entries(files)) {
          mkdirSync(dirname(join(root, path)), { recursive: true });
          writeFileSync(join(root, path), text);
        }
        check(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it('fails on an export of each kind that has no JSDoc', () => {
      inTempTree(
        {
          'kinds.ts': [
            'export function f() {}',
            'export async function g() {}',
            'export const c = 1;',
            'export let l = 1;',
            'export type T = string;',
            'export interface I {}',
            'export class K {}',
            'export abstract class A {}',
            'export enum E {}',
            '',
          ].join('\n'),
        },
        (root) => {
          expect(problems(root)).toEqual([
            'kinds.ts:1 f: no JSDoc',
            'kinds.ts:2 g: no JSDoc',
            'kinds.ts:3 c: no JSDoc',
            'kinds.ts:4 l: no JSDoc',
            'kinds.ts:5 T: no JSDoc',
            'kinds.ts:6 I: no JSDoc',
            'kinds.ts:7 K: no JSDoc',
            'kinds.ts:8 A: no JSDoc',
            'kinds.ts:9 E: no JSDoc',
          ]);
        },
      );
    });

    it('accepts a one-line and a multi-line JSDoc directly above', () => {
      inTempTree(
        {
          'ok.ts': [
            '/** Does f. */',
            'export function f() {}',
            '',
            '/**',
            ' * Holds c.',
            ' *',
            ' * @throws Error never.',
            ' */',
            'export const c = 1;',
            '',
          ].join('\n'),
        },
        (root) => {
          expect(problems(root)).toEqual([]);
        },
      );
    });

    it('does not count anything that is not a JSDoc directly above', () => {
      inTempTree(
        {
          'weak.ts': [
            '/** Separated by a blank line. */',
            '',
            'export const apart = 1;',
            '',
            '/* A plain block comment. */',
            'export const plain = 1;',
            '',
            '// A line comment.',
            'export const line = 1;',
            '',
            '/** Documents the first one only. */',
            'export const first = 1;',
            '// A line comment ending a block */',
            'export const second = 1;',
            '',
            '/** */',
            'export const empty = 1;',
            '',
          ].join('\n'),
        },
        (root) => {
          expect(problems(root)).toEqual([
            'weak.ts:3 apart: no JSDoc',
            'weak.ts:6 plain: no JSDoc',
            'weak.ts:9 line: no JSDoc',
            'weak.ts:14 second: no JSDoc',
            'weak.ts:17 empty: empty JSDoc',
          ]);
        },
      );
    });

    it('needs a JSDoc on the first overload only', () => {
      inTempTree(
        {
          'overloads.ts': [
            '/** Opens by name or number. */',
            'export function open(a: string): string;',
            'export function open(a: number): number;',
            'export function open(a: unknown): unknown {',
            '  return a;',
            '}',
            '',
            'export function bare(a: string): string;',
            '/** Documented too late. */',
            'export function bare(a: number): number;',
            'export function bare(a: unknown): unknown {',
            '  return a;',
            '}',
            '',
          ].join('\n'),
        },
        (root) => {
          expect(problems(root)).toEqual(['overloads.ts:8 bare: no JSDoc']);
        },
      );
    });

    it('ignores re-exports and test files, and refuses an export it cannot read', () => {
      inTempTree(
        {
          'index.ts': [
            "export * from './a.js';",
            "export * as ns from './a.js';",
            "export { a } from './a.js';",
            'export {',
            '  b,',
            "} from './b.js';",
            "export type { T } from './a.js';",
            '',
          ].join('\n'),
          'thing.test.ts': 'export const undocumented = 1;\n',
          'default.ts': 'const x = 1;\nexport default x;\n',
        },
        (root) => {
          expect(problems(root)).toEqual([
            'default.ts:2 export default x;: unrecognised export form',
          ]);
        },
      );
    });
  });
});
