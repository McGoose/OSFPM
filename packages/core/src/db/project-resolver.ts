import type { PgTable } from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';
import type { SchemaDb } from './client.js';

/**
 * Finds the project a record belongs to, or `null` when it belongs to the
 * organisation only. `row` is the stored row, keyed by Drizzle property names.
 * A resolver may query, using the write's own transaction.
 */
export type ProjectResolver = (
  tx: SchemaDb,
  row: Record<string, unknown>,
) => Promise<string | null>;

const resolvers = new WeakMap<PgTable, ProjectResolver>();
const parentKeys = new WeakMap<PgTable, readonly string[]>();

/**
 * Tells the write helper how to find the project of a table's rows. Call it
 * once, next to the table definition, for tables that have no `project_id`
 * column of their own (a child record whose project comes from its parent) or
 * whose project is something else. The helper uses the answer to pick the
 * project's `change_seq` counter and to fill `change_event.project_id`.
 *
 * Tables with a `project_id` column need nothing: that is the default.
 *
 * `parentKeys` names the columns (by property key) the resolver reads. They
 * become immutable, because changing one could move the record to another
 * project. Moving a record to another parent is a delete plus a create.
 */
export function registerProjectResolver(
  table: PgTable,
  resolver: ProjectResolver,
  options: { parentKeys?: readonly string[] } = {},
): void {
  if (resolvers.has(table)) {
    throw new Error(
      `A project resolver is already registered for ${getTableName(table)}`,
    );
  }
  resolvers.set(table, resolver);
  parentKeys.set(table, options.parentKeys ?? []);
}

/** Columns `updateRecord` must refuse to change because the project resolver reads them. */
export function parentKeysOf(table: PgTable): readonly string[] {
  return parentKeys.get(table) ?? [];
}

/** The project of `row`: the registered resolver's answer, else its own `projectId`. */
export function resolveProjectId(
  tx: SchemaDb,
  table: PgTable,
  row: Record<string, unknown>,
): Promise<string | null> {
  const resolver = resolvers.get(table);
  if (resolver) return resolver(tx, row);
  return Promise.resolve(
    typeof row.projectId === 'string' ? row.projectId : null,
  );
}
