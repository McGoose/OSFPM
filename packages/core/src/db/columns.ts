import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  integer,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { newId } from './ids.js';

export const VISIBILITIES = [
  'private',
  'project',
  'shared-with-partners',
] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** SQL list of allowed values, e.g. `'a', 'b'`, for use in CHECK constraints. */
export function sqlList(values: readonly string[]): SQL {
  return sql.raw(values.map((v) => `'${v}'`).join(', '));
}

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

/** Lazily resolves `user.id`, so table modules need no import cycle. */
export type UserIdRef = () => AnyPgColumn;

/**
 * Columns every table carries, except the `organisation_id`, `owner_org_id`
 * and `visibility` trio, which install-level tables such as `user` omit.
 */
export function baseColumns(userId: UserIdRef) {
  return {
    id: uuid('id').primaryKey().$defaultFn(newId),
    originServer: uuid('origin_server').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
    createdBy: uuid('created_by').references(userId),
    updatedBy: uuid('updated_by').references(userId),
    deletedAt: timestamptz('deleted_at'),
    deletedBy: uuid('deleted_by').references(userId),
    retentionClass: text('retention_class'),
  };
}

/** The full standard column set. `visibility` defaults to `project`. */
export function standardColumns(
  userId: UserIdRef,
  options: { defaultVisibility?: Visibility } = {},
) {
  return {
    ...baseColumns(userId),
    organisationId: uuid('organisation_id').notNull(),
    ownerOrgId: uuid('owner_org_id').notNull(),
    visibility: text('visibility')
      .$type<Visibility>()
      .notNull()
      .default(options.defaultVisibility ?? 'project'),
  };
}

/** CHECK constraint for the `visibility` column of a standard table. */
export function visibilityCheck(tableName: string, visibility: AnyPgColumn) {
  return check(
    `${tableName}_visibility_check`,
    sql`${visibility} in (${sqlList(VISIBILITIES)})`,
  );
}
