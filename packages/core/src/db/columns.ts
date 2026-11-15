import { sql } from 'drizzle-orm';
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
import { retentionClass } from './schema/retention-class.js';
import { sqlList } from './sql-list.js';

export { sqlList };

export const VISIBILITIES = [
  'private',
  'project',
  'shared-with-partners',
] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

/** Lazily resolves `user.id`, so table modules need no import cycle. */
export type UserIdRef = () => AnyPgColumn;

/** Lazily resolves `organisation.id`, for the same reason as `UserIdRef`. */
export type OrganisationIdRef = () => AnyPgColumn;

/** The retention class a table gets unless it passes `defaultRetentionClass`. */
const DEFAULT_RETENTION_CLASS = 'standard';

/** `retention_class` column builders made with `defaultRetentionClass`, and the class each declared. */
const declaredByColumn = new WeakMap<object, string>();

/** Classes declared through `defaultRetentionClass`, by name of the tenant table. */
const declaredByTable = new Map<string, string>();

/**
 * The retention class each tenant table declared through the
 * `defaultRetentionClass` option, by table name. A table not listed here did
 * not use the option, so its `retention_class` defaults to `standard`. Redefining
 * the column by hand is not a declaration.
 */
export function declaredRetentionClasses(): ReadonlyMap<string, string> {
  return declaredByTable;
}

/**
 * Columns every table carries, except the `organisation_id`, `owner_org_id`
 * and `visibility` trio, which install-level tables such as `user` omit.
 * `retention_class` defaults to `standard`; `defaultRetentionClass` picks
 * another class. `tenantTable` records that choice (see
 * `declaredRetentionClasses`), so use the option through `standardColumns`.
 */
export function baseColumns(
  userId: UserIdRef,
  options: { defaultRetentionClass?: string } = {},
) {
  const retentionClassColumn = text('retention_class')
    .notNull()
    .default(options.defaultRetentionClass ?? DEFAULT_RETENTION_CLASS);
  if (options.defaultRetentionClass !== undefined) {
    declaredByColumn.set(retentionClassColumn, options.defaultRetentionClass);
  }
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
    retentionClass: retentionClassColumn,
  };
}

/** Name of the foreign key from a table's `retention_class` to `retention_class.key`. */
export function retentionClassForeignKeyName(tableName: string): string {
  return `${tableName}_retention_class_fk`;
}

/**
 * The foreign key every table with a `retention_class` column carries.
 * `tenantTable` adds it to tenant tables; install-level tables built from
 * `baseColumns` add it themselves.
 */
export function retentionClassForeignKey(
  tableName: string,
  column: AnyPgColumn,
) {
  return foreignKey({
    name: retentionClassForeignKeyName(tableName),
    columns: [column],
    foreignColumns: [retentionClass.key],
  });
}

/**
 * The full standard column set. `organisation_id` carries no foreign key here:
 * `tenantTable` adds it, so every tenant table names it the same way.
 * `visibility` defaults to `project` and `retention_class` to `standard`;
 * `defaultVisibility` and `defaultRetentionClass` pick others.
 */
export function standardColumns(
  userId: UserIdRef,
  options: {
    defaultVisibility?: Visibility;
    defaultRetentionClass?: string;
  } = {},
) {
  return {
    ...baseColumns(userId, options),
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
 * and stays within PostgreSQL's 63-character limit. It also adds the foreign
 * key from `retention_class` to `retention_class.key`, named
 * `<table>_retention_class_fk`, and the
 * `<table>_visibility_check` CHECK, so tables do not repeat it. Every tenant table goes
 * through this wrapper; use plain `pgTable` only for install-level tables.
 * It also records a retention class the table chose through
 * `defaultRetentionClass` (see `declaredRetentionClasses`).
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
  const declaredClass = declaredByColumn.get(columns.retentionClass);
  if (declaredClass !== undefined) declaredByTable.set(name, declaredClass);
  return pgTable(name, columns, (self) => [
    foreignKey({
      name: organisationForeignKeyName(name),
      columns: [
        (self as unknown as { organisationId: AnyPgColumn }).organisationId,
      ],
      foreignColumns: [organisationId()],
    }),
    retentionClassForeignKey(
      name,
      (self as unknown as { retentionClass: AnyPgColumn }).retentionClass,
    ),
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
