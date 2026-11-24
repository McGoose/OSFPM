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
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as schemaModule from './schema/index.js';

/**
 * CLAUDE.md, Data rules: reads of person and user list their columns explicitly; never
 * select the whole row. `person` and `user` hold what a service must not hand on by
 * accident: a column added to either one later (the delivery preferences, a credential, a
 * contact detail) would otherwise reach every caller of a read written before it. This
 * scans every source file of `packages/core/src` for a Drizzle read that selects every
 * column of either table, and allows nothing: there is no list of exceptions to keep.
 *
 * It parses the code and does not match text, so formatting, comments and strings do not
 * matter. A whole-row read is one of: `select()` (or `selectDistinct()`) with a `from` or a
 * join of the table; the table itself as a value of the select list (`select({ person })`);
 * `getTableColumns(table)`, which is every column; the relational API (`db.query.person`);
 * and raw SQL that selects `*` from the table or `table.*`. Writes are not reads, so a
 * `.returning()` is not seen. The scan names tables by the identifier the schema exports,
 * so it cannot see a table passed around in a variable (the write helper's generic reads
 * take `table` as a parameter, and are not about these two tables).
 *
 * Files that end in `.test.ts` are skipped: a test may read a whole row to check what was
 * written. Everything else is scanned, the helpers that tests import (`test-support.ts`,
 * `test-fixtures.ts`) included; a helper that needs a whole row lists its columns, or the
 * read lives in a test file.
 */

/** The tables the rule names, by table name. */
const RULE_TABLES = ['person', 'user'];

/** The identifiers the schema exports for the tables of the rule, so a renamed export is followed. */
function ruleIdentifiers(): Set<string> {
  return new Set(
    Object.entries(schemaModule).flatMap(([identifier, value]) =>
      is(value, PgTable) && RULE_TABLES.includes(getTableName(value))
        ? [identifier]
        : [],
    ),
  );
}

/** One whole-row read: the line it is on and which form of it this is. */
type WholeRowRead = { readonly line: number; readonly form: string };

/** The Drizzle calls that start a read. */
const SELECT_CALLS = new Set(['select', 'selectDistinct', 'selectDistinctOn']);

/** The name a call is made through: `x.name(...)` or `name(...)`. */
function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** The table of the rule an expression names (`person`, `schema.person`), or `undefined`. */
function tableNamed(
  node: ts.Node | undefined,
  tables: ReadonlySet<string>,
): string | undefined {
  if (node === undefined) return undefined;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return tableNamed(node.expression, tables);
  }
  if (ts.isIdentifier(node))
    return tables.has(node.text) ? node.text : undefined;
  if (ts.isPropertyAccessExpression(node)) {
    return tables.has(node.name.text) &&
      (ts.isIdentifier(node.expression) ||
        ts.isPropertyAccessExpression(node.expression))
      ? node.name.text
      : undefined;
  }
  return undefined;
}

/** The calls made on the result of `call`, in order: `.from(x)`, `.innerJoin(y, on)`, `.where(z)`. */
function chainAfter(call: ts.CallExpression): ts.CallExpression[] {
  const links: ts.CallExpression[] = [];
  let current: ts.Node = call;
  for (;;) {
    const access = current.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== current)
      break;
    const next = access.parent;
    if (!ts.isCallExpression(next) || next.expression !== access) break;
    links.push(next);
    current = next;
  }
  return links;
}

/** The table of the rule a `from` or a join of a select names, or `undefined`. */
function tableOfSource(
  link: ts.CallExpression,
  tables: ReadonlySet<string>,
): string | undefined {
  const name = calleeName(link);
  if (name === undefined) return undefined;
  const isSource =
    name === 'from' || name.endsWith('Join') || name.endsWith('JoinLateral');
  return isSource ? tableNamed(link.arguments[0], tables) : undefined;
}

/**
 * The table of the rule that a select list takes whole: as a value (`{ p: person }`), in
 * shorthand (`{ person }`) or inside a nested list. A list that is a name, such as a
 * constant somebody wrote, is not looked into: it lists what it lists.
 */
function tableInList(
  list: ts.Expression,
  tables: ReadonlySet<string>,
): string | undefined {
  if (!ts.isObjectLiteralExpression(list)) return undefined;
  for (const property of list.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      if (tables.has(property.name.text)) return property.name.text;
    } else if (ts.isPropertyAssignment(property)) {
      const whole =
        tableNamed(property.initializer, tables) ??
        tableInList(property.initializer, tables);
      if (whole !== undefined) return whole;
    }
  }
  return undefined;
}

/** `select * from <table>` and `<table>.*`, case-insensitive, with the table quoted or not. */
const RAW_SELECT_STAR = /\bselect\s+\*\s+from\s+"?(?:person|user)"?(?![\w$])/i;
const RAW_TABLE_STAR = /(?<![\w$])"?(?:person|user)"?\s*\.\s*\*/i;

/** The text of a string or a template that could be SQL, with a table in `${}` written as its name. */
function sqlText(
  node: ts.Node,
  tables: ReadonlySet<string>,
): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans
        .map(
          (span) =>
            (tableNamed(span.expression, tables) ?? '?') + span.literal.text,
        )
        .join('')
    );
  }
  return undefined;
}

/** The whole-row reads of `person` and `user` (`tables` are their exported identifiers) in one file's text. */
function wholeRowReads(
  source: string,
  tables: ReadonlySet<string>,
): WholeRowRead[] {
  const file = ts.createSourceFile(
    'scanned.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  // By position, so a read that two rules see counts once.
  const found = new Map<number, WholeRowRead>();
  const add = (at: ts.Node, form: string) => {
    const start = at.getStart(file);
    found.set(start, {
      line: file.getLineAndCharacterOfPosition(start).line + 1,
      form,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === 'getTableColumns') {
        const table = tableNamed(node.arguments[0], tables);
        if (table !== undefined) add(node, `getTableColumns(${table})`);
      }
      if (
        name !== undefined &&
        SELECT_CALLS.has(name) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const list =
          name === 'selectDistinctOn' ? node.arguments[1] : node.arguments[0];
        if (list === undefined) {
          // `select()` takes every column of the table it reads from and of each it joins.
          for (const link of chainAfter(node)) {
            const table = tableOfSource(link, tables);
            if (
              table !== undefined &&
              ts.isPropertyAccessExpression(link.expression)
            ) {
              add(link.expression.name, `select() from ${table}`);
            }
          }
        } else {
          const table = tableInList(list, tables);
          if (table !== undefined) add(list, `${table} as a value of the list`);
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'query' &&
      tables.has(node.name.text)
    ) {
      add(node, `relational query on ${node.name.text}`);
    }
    const text = sqlText(node, tables);
    if (
      text !== undefined &&
      (RAW_SELECT_STAR.test(text) || RAW_TABLE_STAR.test(text))
    ) {
      add(node, 'raw SQL that selects every column');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...found.values()].sort((a, b) => a.line - b.line);
}

/** Source files under `root`: every `.ts` file but the tests (`.test.ts`) and what is in `node_modules`. */
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

/** Every whole-row read under `root`, as `path:line form`, with forward slashes in the path. */
function violations(root: string, tables: ReadonlySet<string>): string[] {
  return sourceFiles(root).flatMap((file) =>
    wholeRowReads(readFileSync(file, 'utf8'), tables).map(
      (read) =>
        `${relative(root, file).split(sep).join('/')}:${read.line} ${read.form}`,
    ),
  );
}

/** `packages/core/src`. */
const CORE_SOURCE = fileURLToPath(new URL('../', import.meta.url));

describe('whole-row reads of person and user', () => {
  const tables = ruleIdentifiers();

  it('finds the two tables of the rule in the schema', () => {
    expect([...tables].sort()).toEqual(['person', 'user']);
  });

  it('are nowhere in the source of packages/core/src', () => {
    const files = sourceFiles(CORE_SOURCE).map((file) =>
      relative(CORE_SOURCE, file).split(sep).join('/'),
    );
    // Guards against scanning nothing and passing for nothing.
    expect(files.length).toBeGreaterThan(150);
    expect(files).toContain('sensitive/records.ts');
    expect(files).toContain('db/write.ts');
    expect(files.some((file) => file.endsWith('.test.ts'))).toBe(false);
    expect(violations(CORE_SOURCE, tables)).toEqual([]);
  });

  describe('sees each form of a whole-row read, once', () => {
    it.each([
      [
        'an empty select from person',
        'const x = await tx.select().from(person).where(eq(person.id, id));',
        'select() from person',
      ],
      [
        'an empty select from user',
        'const [x] = await tx.select().from(user).limit(1);',
        'select() from user',
      ],
      [
        'a distinct empty select',
        'await tx.selectDistinct().from(person);',
        'select() from person',
      ],
      [
        'a select that is formatted over lines',
        'await tx\n  .select()\n  .from(\n    person,\n  )\n  .where(x);',
        'select() from person',
      ],
      [
        'a table reached through a namespace',
        'await tx.select().from(schema.person);',
        'select() from person',
      ],
      [
        'a join of person',
        'await tx.select().from(project).innerJoin(person, eq(a, b));',
        'select() from person',
      ],
      [
        'a left join of user',
        'await tx.select().from(project).leftJoin(user, eq(a, b));',
        'select() from user',
      ],
      [
        'the table as a value of the list',
        'await tx.select({ p: person, id: project.id }).from(project);',
        'person as a value of the list',
      ],
      [
        'the table as a shorthand value of the list',
        'await tx.select({ person }).from(project);',
        'person as a value of the list',
      ],
      [
        'the table inside a nested list',
        'await tx.select({ nested: { u: user } }).from(project);',
        'user as a value of the list',
      ],
      [
        'every column through getTableColumns',
        'await tx.select({ ...getTableColumns(person) }).from(person);',
        'getTableColumns(person)',
      ],
      [
        'getTableColumns on its own',
        'const columns = getTableColumns(schema.user);',
        'getTableColumns(user)',
      ],
      [
        'the relational API',
        'await db.query.person.findMany();',
        'relational query on person',
      ],
      [
        'raw SQL that selects star from the table',
        'await tx.execute(sql`select * from person where id = ${id}`);',
        'raw SQL that selects every column',
      ],
      [
        'raw SQL that selects the star of a quoted table',
        'await tx.execute(sql`select "user".* from "user"`);',
        'raw SQL that selects every column',
      ],
      [
        'raw SQL that names the table as a value',
        'await tx.execute(sql`select * from ${person}`);',
        'raw SQL that selects every column',
      ],
    ])('%s', (_name, code, form) => {
      expect(wholeRowReads(code, tables).map((read) => read.form)).toEqual([
        form,
      ]);
    });

    it('says which line it is on', () => {
      const code = 'const a = 1;\n\nawait tx\n  .select()\n  .from(person);\n';
      expect(wholeRowReads(code, tables)).toEqual([
        { line: 5, form: 'select() from person' },
      ]);
    });
  });

  describe('lets a read that lists its columns through', () => {
    it.each([
      [
        'columns of the table',
        'await tx.select({ id: person.id, userId: person.userId }).from(person);',
      ],
      [
        'columns of user, with a lock',
        "await tx.select({ deletedAt: user.deletedAt }).from(user).limit(1).for('key share');",
      ],
      [
        'columns, with the table only joined',
        'await tx.select({ id: project.id }).from(project).innerJoin(person, eq(a, b));',
      ],
      [
        'a list that is a constant',
        'await tx.select(PERSON_COLUMNS).from(person);',
      ],
      [
        'a list that spreads a constant',
        'await tx.select({ ...PERSON_COLUMNS }).from(person);',
      ],
      [
        'a count',
        'await tx.select({ n: sql<number>`count(*)` }).from(person);',
      ],
      ['an empty select of another table', 'await tx.select().from(project);'],
      [
        'a table whose name starts like one of the two',
        'await tx.select().from(personNote).innerJoin(userNote, x);',
      ],
      [
        'a write that returns its row',
        'await tx.insert(person).values(row).returning();',
      ],
      [
        'a table that is a parameter',
        'await tx.select().from(table).where(eq(table.id, id));',
      ],
      [
        'a comment',
        '// await tx.select().from(person);\n/* select * from person */',
      ],
      ['a string', "const note = 'tx.select().from(person)';"],
      [
        'a raw query that lists its columns',
        'await tx.execute(sql`select id, deleted_at from "user" where id = ${id}`);',
      ],
    ])('%s', (_name, code) => {
      expect(wholeRowReads(code, tables)).toEqual([]);
    });
  });

  it('skips the files that end in .test.ts, and only those', () => {
    const root = mkdtempSync(join(tmpdir(), 'osfpm-whole-row-'));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      const whole = 'await tx.select().from(person);\n';
      write('a/read.test.ts', whole);
      write('a/read.ts', whole);
      write('a/test-support.ts', whole);
      write('b/test-fixtures.ts', whole);
      write('b/lists.ts', 'await tx.select({ id: person.id }).from(person);\n');
      write('b/node_modules/dep/index.ts', whole);
      expect(violations(root, tables)).toEqual([
        'a/read.ts:1 select() from person',
        'a/test-support.ts:1 select() from person',
        'b/test-fixtures.ts:1 select() from person',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
