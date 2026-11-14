/** Tables that may only ever be inserted into. */
export const APPEND_ONLY_TABLES = ['change_event', 'audit_event'] as const;

/** SQLSTATE raised by the append-only trigger (`restrict_violation`). */
export const APPEND_ONLY_SQLSTATE = '23001';

const FUNCTION_NAME = 'osfpm_reject_log_change';

/**
 * SQL that makes the log tables append-only in the database itself: a
 * statement-level trigger raises an error on UPDATE, DELETE and TRUNCATE, even
 * when the statement matches no rows. The message names the table and the
 * operation only, never row data.
 *
 * Triggers cannot be declared in the Drizzle schema, so migration
 * `0004_change_and_audit_logs.sql` contains this text. A test checks that the
 * two stay identical. Statements are separated by Drizzle's breakpoint marker.
 */
export function appendOnlyMigrationSql(): string {
  const statements = [
    `CREATE FUNCTION ${FUNCTION_NAME}() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '${APPEND_ONLY_SQLSTATE}';
END;
$$;`,
    ...APPEND_ONLY_TABLES.map(
      (table) =>
        `CREATE TRIGGER ${table}_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON "${table}"
FOR EACH STATEMENT EXECUTE FUNCTION ${FUNCTION_NAME}();`,
    ),
  ];
  return statements.join('\n--> statement-breakpoint\n');
}
