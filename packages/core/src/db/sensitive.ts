import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

const registry = new WeakMap<PgTable, Set<string>>();

/**
 * Tags columns of `table` as `sensitive`. The write helper then keeps their
 * values out of `change_event.before` and `.after`; only the names appear in
 * `changed_fields`. Call it once, next to the table definition.
 *
 * Columns are given by their property key in the Drizzle table. A table can
 * only gain sensitive columns, never lose them. This is how a table keeps
 * values out of events and logs (CLAUDE.md, Data rules and Privacy rule).
 *
 * @throws Error when a key is not an own column of the table.
 */
export function markSensitive<T extends PgTable>(
  table: T,
  columns: readonly (keyof T['_']['columns'] & string)[],
): void {
  const known = getTableColumns(table);
  const names = registry.get(table) ?? new Set<string>();
  for (const key of columns) {
    // Own keys only, so `constructor` or `toString` is not taken for a column.
    const column = Object.hasOwn(known, key) ? known[key] : undefined;
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
