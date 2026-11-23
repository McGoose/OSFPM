import { getTableName, sql } from 'drizzle-orm';
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
  type PgTable,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { newId } from './ids.js';
import { retentionClass } from './schema/retention-class.js';
import { sqlList } from './sql-list.js';

export { sqlList };

/**
 * Allowed `visibility` markers on a tenant record (CLAUDE.md, Data rules).
 * `tenantTable` builds `<table>_visibility_check` from this list, so a new
 * value needs a new migration.
 */
export const VISIBILITIES = [
  'private',
  'project',
  'shared-with-partners',
] as const;
/** One value of `VISIBILITIES`. */
export type Visibility = (typeof VISIBILITIES)[number];

/**
 * A `timestamptz` column read and written as a JS `Date`. PostgreSQL stores the
 * instant in UTC (CLAUDE.md, Data rules).
 */
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

/** Classes declared through `defaultRetentionClass`, by name of the tenant or security table. */
const declaredByTable = new Map<string, string>();

/**
 * The retention class each tenant or security table declared through the
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
 * another class. `tenantTable` and `securityTable` record that choice (see
 * `declaredRetentionClasses`), so use the option through `standardColumns` or
 * give `baseColumns` to `securityTable`.
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
 * through this wrapper; use plain `pgTable` only for install-level tables
 * (CLAUDE.md, Data rules). It also records a retention class the table chose
 * through `defaultRetentionClass` (see `declaredRetentionClasses`).
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
  // `self` is typed from the caller's columns. The casts below are safe because
  // `TenantColumns` requires these three columns on every tenant table.
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

/** Columns a security table must have: the ones `baseColumns` returns. */
type SecurityColumns = Record<string, PgColumnBuilderBase> &
  ReturnType<typeof baseColumns>;

const securityTableRegistry = new Set<string>();

/** Names of all tables defined through `securityTable`. */
export function securityTableNames(): ReadonlySet<string> {
  return securityTableRegistry;
}

/** The security tables that carry `organisation_id` by declaration, with the reason each gave. */
const organisationScopedSecurityRegistry = new Map<string, string>();

/**
 * The security tables that declared `organisationScoped` (see `securityTable`),
 * by table name, with the reason each gave. A security table not listed here has
 * no `organisation_id`; the structural tests compare the schema with this record,
 * so an exception is a declaration in code and not a list kept in a test.
 */
export function organisationScopedSecurityTables(): ReadonlyMap<
  string,
  string
> {
  return organisationScopedSecurityRegistry;
}

/** What `securityChildTable` records about a table. */
export type SecurityChildRecord = {
  /** The security table whose rows this table's rows belong to, by name. */
  readonly parent: string;
  /** Why it exists in this form, in a sentence. */
  readonly reason: string;
};

const securityChildRegistry = new Map<string, SecurityChildRecord>();

/**
 * The child tables of security tables declared through `securityChildTable`, by
 * table name, with the parent and the reason each gave.
 */
export function securityChildTables(): ReadonlyMap<
  string,
  SecurityChildRecord
> {
  return securityChildRegistry;
}

/**
 * True when `name` is a security table, or the child table of one. Only the auth
 * service writes such a table, and the write helper refuses it even when it has an
 * `organisation_id` (CLAUDE.md, Data rules).
 */
export function isSecurityTableName(name: string): boolean {
  return securityTableRegistry.has(name) || securityChildRegistry.has(name);
}

/**
 * The folder of `packages/core/src/` that writes every security table and every
 * service-written table unless the table declares another: the auth service
 * (CLAUDE.md, Data rules).
 */
export const DEFAULT_TABLE_WRITER = 'auth';

/**
 * What a table declares about who writes it: the folder of `packages/core/src/`
 * that is the only code allowed to write it. A folder other than the default also
 * says why, in one line.
 */
export type WrittenBy = {
  /** The folder, such as `auth` or `sensitive`. */
  readonly service: string;
  /** One line saying why the writer is not the default. Needed when it is not, and ignored when it is. */
  readonly reason?: string;
};

/** The writer of one table, as `tableWriters` records it. */
export type TableWriter = {
  /** A security table, or an install-level table that only a named service writes. */
  readonly kind: 'security' | 'service-written';
  /** The folder of `packages/core/src/` that is the only code allowed to write the table. */
  readonly service: string;
  /** Why the writer is not the default, in one line; `null` when it is the default. */
  readonly reason: string | null;
};

const tableWriterRegistry = new Map<string, TableWriter>();

/**
 * Who writes each security table and each service-written table, by table name: the
 * one record, filled in where the tables are declared (`securityTable` and
 * `declareServiceWrittenTable`). A table not listed here is a tenant table, written
 * through the write helper, or a table with no named writer. `write-helper-scan.test.ts`
 * reads it, and fails when a listed table is written from any other folder, and when a
 * declared folder does not exist, so the record cannot drift from the code.
 */
export function tableWriters(): ReadonlyMap<string, TableWriter> {
  return tableWriterRegistry;
}

/**
 * The names of the service-written tables: install-level tables, apart from the
 * security tables, that only one named core service writes (`SERVICE_WRITTEN_TABLES`).
 */
export function serviceWrittenTableNames(): ReadonlySet<string> {
  return new Set(
    [...tableWriterRegistry]
      .filter(([, writer]) => writer.kind === 'service-written')
      .map(([name]) => name),
  );
}

/** A folder name of `packages/core/src/`: lower-case letters, digits and hyphens, starting with a letter. */
const FOLDER_NAME = /^[a-z][a-z0-9-]*$/;

/** Checks what a table declared about its writer and turns it into a record. */
function resolveWriter(
  kind: TableWriter['kind'],
  name: string,
  writtenBy: WrittenBy | undefined,
): TableWriter {
  const service = writtenBy?.service ?? DEFAULT_TABLE_WRITER;
  if (!FOLDER_NAME.test(service)) {
    throw new Error(`${name} declares a writer that is not a folder name`);
  }
  if (service === DEFAULT_TABLE_WRITER) return { kind, service, reason: null };
  const reason = (writtenBy?.reason ?? '').trim();
  if (reason === '') {
    throw new Error(
      `${name} declares ${service} as its writer without a reason`,
    );
  }
  if (reason.includes('\n') || reason.includes('\r')) {
    throw new Error(
      `${name} gives the reason for its writer in more than one line`,
    );
  }
  return { kind, service, reason };
}

/** Records a writer, and refuses a table that is already recorded with a different one. */
function recordWriter(name: string, writer: TableWriter): void {
  const known = tableWriterRegistry.get(name);
  if (
    known !== undefined &&
    (known.kind !== writer.kind ||
      known.service !== writer.service ||
      known.reason !== writer.reason)
  ) {
    throw new Error(`${name} already has a different writer declared`);
  }
  tableWriterRegistry.set(name, writer);
}

/**
 * Declares an install-level table, apart from the security tables, that only one named
 * core service writes: never the write helper, and audited instead of change-logged
 * (CLAUDE.md, Data rules). Records the table's writer in `tableWriters`, which is the
 * auth service unless `writtenBy` names another folder and says why in one line, and
 * returns the table, so `SERVICE_WRITTEN_TABLES` is a list of declarations.
 *
 * @throws Error when the writer is not a folder name, when a writer other than the
 * default has no reason or one of more than one line, and when the table is a tenant
 * table or already has a different writer.
 */
export function declareServiceWrittenTable<T extends PgTable>(
  table: T,
  writtenBy: WrittenBy,
): T {
  const name = getTableName(table);
  if (tenantTableRegistry.has(name)) {
    throw new Error(`${name} is a tenant table, so the write helper writes it`);
  }
  recordWriter(name, resolveWriter('service-written', name, writtenBy));
  return table;
}

/** Throws unless `columns` has an `organisationId` column and `reason` says something. */
function checkDeclaration(
  what: string,
  name: string,
  columns: object,
  reason: string,
): void {
  if (!Object.hasOwn(columns, 'organisationId')) {
    throw new Error(
      `${name} declares ${what} but has no organisationId column`,
    );
  }
  if (reason.trim() === '') {
    throw new Error(`${name} declares ${what} without a reason`);
  }
}

/**
 * Defines a security table: an install-level table of login state (sessions,
 * credentials, one-time codes) built from `baseColumns`. It adds the
 * `<table>_retention_class_fk` foreign key, as `tenantTable` does, and records
 * a retention class chosen through `defaultRetentionClass` (see
 * `declaredRetentionClasses`). It also records the table's name (see
 * `securityTableNames`), so the structural tests can tell it from a tenant
 * table.
 *
 * A security table has no `organisation_id`, so the write helper cannot write
 * it. Only one service writes it, directly, and records each security-relevant
 * change as an `audit_event` instead of a `change_event` (CLAUDE.md, Data rules).
 * That is the auth service unless the table declares another with
 * `options.writtenBy`, which names the folder of `packages/core/src/` and says why
 * in one line; either way the writer is recorded in `tableWriters`, which
 * `write-helper-scan.test.ts` reads. Add every new one to `SECURITY_TABLES`.
 *
 * The one exception is declared with `options.organisationScoped`: a table whose
 * rows belong to one organisation, and which other tables point at through a
 * composite key (`organisation_id`, `id`), so that a row of one organisation can
 * never be tied to a record of another. Its columns then include
 * `organisationId`, and this adds the foreign key to the organisation, named
 * `<table>_organisation_fk` like every other table's, and records the table and the
 * `reason` (see `organisationScopedSecurityTables`). It gets no `owner_org_id` and
 * no `visibility`, and the write helper refuses it though it has an
 * `organisation_id`.
 *
 * @throws Error when `organisationScoped` is given and the columns have no
 * `organisationId`, or the reason is empty, and when `writtenBy` names a folder that
 * is not a folder name, or one other than the default with no reason or one of more
 * than one line.
 */
export function securityTable<
  TName extends string,
  TColumns extends SecurityColumns,
>(
  name: TName,
  columns: TColumns,
  extraConfig?: (
    self: BuildExtraConfigColumns<TName, TColumns, 'pg'>,
  ) => PgTableExtraConfigValue[],
  options: {
    readonly organisationScoped?: {
      readonly organisationId: OrganisationIdRef;
      readonly reason: string;
    };
    readonly writtenBy?: WrittenBy;
  } = {},
) {
  const scoped = options.organisationScoped;
  if (scoped !== undefined) {
    checkDeclaration('organisationScoped', name, columns, scoped.reason);
  }
  // Checked before anything is recorded, so a refused declaration leaves no trace.
  const writer = resolveWriter('security', name, options.writtenBy);
  recordWriter(name, writer);
  securityTableRegistry.add(name);
  if (scoped !== undefined) {
    organisationScopedSecurityRegistry.set(name, scoped.reason);
  }
  const declaredClass = declaredByColumn.get(columns.retentionClass);
  if (declaredClass !== undefined) declaredByTable.set(name, declaredClass);
  // The casts are safe because `SecurityColumns` requires `retentionClass`, and
  // `checkDeclaration` has checked `organisationId` when it is used.
  return pgTable(name, columns, (self) => [
    retentionClassForeignKey(
      name,
      (self as unknown as { retentionClass: AnyPgColumn }).retentionClass,
    ),
    ...(scoped === undefined
      ? []
      : [
          foreignKey({
            name: organisationForeignKeyName(name),
            columns: [
              (self as unknown as { organisationId: AnyPgColumn })
                .organisationId,
            ],
            foreignColumns: [scoped.organisationId()],
          }),
        ]),
    ...(extraConfig?.(self) ?? []),
  ]);
}

/**
 * Defines the child table of a security table: rows that belong to one row of
 * `options.parent` and are deleted with it (`ON DELETE CASCADE`), so they have no
 * columns of the standard set and no retention class of their own: the parent's
 * cleanup removes both. Its columns include `organisationId`, which this ties to
 * the organisation with the foreign key `<table>_organisation_fk`; the table adds
 * its composite keys (`organisation_id` with the parent's id, `organisation_id` with
 * any tenant record it points at) in `extraConfig`, so a row can never join two
 * organisations. It records the name, the parent and the `reason` (see
 * `securityChildTables`), so the structural tests and the write helper know it.
 *
 * Like a security table it is written only by the auth service, directly, and the
 * write helper refuses it though it has an `organisation_id`. Add every new one to
 * `SECURITY_CHILD_TABLES`.
 *
 * @throws Error when the columns have no `organisationId`, or the reason is empty.
 */
export function securityChildTable<
  TName extends string,
  TColumns extends Record<string, PgColumnBuilderBase>,
>(
  name: TName,
  columns: TColumns,
  extraConfig:
    | ((
        self: BuildExtraConfigColumns<TName, TColumns, 'pg'>,
      ) => PgTableExtraConfigValue[])
    | undefined,
  options: {
    readonly organisationId: OrganisationIdRef;
    readonly parent: string;
    readonly reason: string;
  },
) {
  checkDeclaration('a security child table', name, columns, options.reason);
  securityChildRegistry.set(name, {
    parent: options.parent,
    reason: options.reason,
  });
  return pgTable(name, columns, (self) => [
    foreignKey({
      name: organisationForeignKeyName(name),
      columns: [
        (self as unknown as { organisationId: AnyPgColumn }).organisationId,
      ],
      foreignColumns: [options.organisationId()],
    }),
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

/**
 * Kinds of actor named on `change_event` and `audit_event`; both tables' CHECKs
 * are built from this list, so a new value needs a new migration. A `token` or
 * `email` actor acts for a user (see `WriteContext`).
 */
export const ACTOR_TYPES = [
  'user',
  'token',
  'system',
  'email',
  'federation',
] as const;
/** One value of `ACTOR_TYPES`. */
export type ActorType = (typeof ACTOR_TYPES)[number];
