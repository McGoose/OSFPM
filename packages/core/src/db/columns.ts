import { sql, type SQL } from 'drizzle-orm';
import type { BuildExtraConfigColumns } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
  type PgColumnBuilderBase,
  type PgTableExtraConfigValue,
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

export const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

/** Lazily resolves `user.id`, so table modules need no import cycle. */
export type UserIdRef = () => AnyPgColumn;

/** Lazily resolves `organisation.id`, for the same reason as `UserIdRef`. */
export type OrganisationIdRef = () => AnyPgColumn;

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

/**
 * The full standard column set. `organisation_id` carries no foreign key here:
 * `tenantTable` adds it, so every tenant table names it the same way.
 * `visibility` defaults to `project`.
 */
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

/** Columns a tenant table must have: the ones `standardColumns` returns. */
type TenantColumns = Record<string, PgColumnBuilderBase> &
  ReturnType<typeof standardColumns>;

const tenantTableRegistry = new Set<string>();

/** Names of all tables defined through `tenantTable`. */
export function tenantTableNames(): ReadonlySet<string> {
  return tenantTableRegistry;
}

/**
 * Defines a tenant table: one built from `standardColumns`. Adds the foreign
 * key from `organisation_id` to `organisation.id`, named
 * `<table>_organisation_fk`, so the name never depends on generated defaults
 * and stays within PostgreSQL's 63-character limit. It also adds the
 * `<table>_visibility_check` CHECK, so tables do not repeat it. Every tenant table goes
 * through this wrapper; use plain `pgTable` only for install-level tables.
 *
 * `organisationId` is lazy so table modules need no import cycle.
 */
export function tenantTable<
  TName extends string,
  TColumns extends TenantColumns,
>(
  name: TName,
  organisationId: OrganisationIdRef,
  columns: TColumns,
  extraConfig?: (
    self: BuildExtraConfigColumns<TName, TColumns, 'pg'>,
  ) => PgTableExtraConfigValue[],
) {
  tenantTableRegistry.add(name);
  return pgTable(name, columns, (self) => [
    foreignKey({
      name: organisationForeignKeyName(name),
      columns: [
        (self as unknown as { organisationId: AnyPgColumn }).organisationId,
      ],
      foreignColumns: [organisationId()],
    }),
    visibilityCheck(
      name,
      (self as unknown as { visibility: AnyPgColumn }).visibility,
    ),
    ...(extraConfig?.(self) ?? []),
  ]);
}

/** Name of the foreign key from a tenant table to its organisation. */
export function organisationForeignKeyName(tableName: string): string {
  return `${tableName}_organisation_fk`;
}

/** CHECK constraint for the `visibility` column; `tenantTable` adds it to every tenant table. */
function visibilityCheck(tableName: string, visibility: AnyPgColumn) {
  return check(
    `${tableName}_visibility_check`,
    sql`${visibility} in (${sqlList(VISIBILITIES)})`,
  );
}

export const ACTOR_TYPES = [
  'user',
  'token',
  'system',
  'email',
  'federation',
] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
