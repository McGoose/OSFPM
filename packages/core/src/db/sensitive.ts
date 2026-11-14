import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

const registry = new WeakMap<PgTable, Set<string>>();

/**
 * Tags columns of `table` as `sensitive`. The write helper then keeps their
 * values out of `change_event.before` and `.after`; only the names appear in
 * `changed_fields`. Call it once, next to the table definition.
 *
 * Columns are given by their property key in the Drizzle table. A table can
 * only gain sensitive columns, never lose them.
 */
export function markSensitive<T extends PgTable>(
  table: T,
  columns: readonly (keyof T['_']['columns'] & string)[],
): void {
  const known = getTableColumns(table);
  const names = registry.get(table) ?? new Set<string>();
  for (const key of columns) {
    const column = known[key];
    if (!column) {
      throw new Error(
        `Cannot mark unknown column "${key}" of ${getTableName(table)} as sensitive`,
      );
    }
    names.add(column.name);
  }
  registry.set(table, names);
}

/** Database column names (snake_case) marked sensitive for `table`. */
export function sensitiveColumns(table: PgTable): ReadonlySet<string> {
  return registry.get(table) ?? new Set<string>();
}
