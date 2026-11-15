import { sql, type SQL } from 'drizzle-orm';

/**
 * SQL list of allowed values, e.g. `'a', 'b'`, for use in CHECK constraints.
 * The values go into the SQL text unescaped, so pass only constant lists from
 * code, never a string from a caller.
 */
export function sqlList(values: readonly string[]): SQL {
  return sql.raw(values.map((v) => `'${v}'`).join(', '));
}
