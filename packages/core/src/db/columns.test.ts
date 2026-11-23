import { getTableColumns, sql } from 'drizzle-orm';
import {
  check,
  getTableConfig,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  baseColumns,
  declaredRetentionClasses,
  declareServiceWrittenTable,
  DEFAULT_TABLE_WRITER,
  isSecurityTableName,
  organisationScopedSecurityTables,
  retentionClassForeignKeyName,
  securityChildTable,
  securityChildTables,
  securityTable,
  securityTableNames,
  serviceWrittenTableNames,
  standardColumns,
  tableWriters,
  tenantTable,
  tenantTableNames,
} from './columns.js';
import { organisation } from './schema/organisation.js';
import { user } from './schema/user.js';

// Probe tables, one per way of choosing a retention class. This file has its
// own module registry, so they never reach `schema.test.ts`.
const declared = tenantTable(
  'probe_declared',
  () => organisation.id,
  standardColumns(() => user.id, { defaultRetentionClass: 'contract' }),
);
const plain = tenantTable(
  'probe_plain',
  () => organisation.id,
  standardColumns(() => user.id),
);
// Not through the option: the column is redefined by hand.
const overridden = tenantTable('probe_overridden', () => organisation.id, {
  ...standardColumns(() => user.id),
  retentionClass: text('retention_class').notNull().default('contract'),
});

describe('the defaultRetentionClass option', () => {
  it('sets the column default and records the declaration for the table', () => {
    expect(getTableColumns(declared).retentionClass.default).toBe('contract');
    expect(declaredRetentionClasses().get('probe_declared')).toBe('contract');
  });

  it('leaves the default at standard, and records nothing, when it is not used', () => {
    expect(getTableColumns(plain).retentionClass.default).toBe('standard');
    expect(declaredRetentionClasses().has('probe_plain')).toBe(false);
  });

  // The structural schema test flags a non-standard default that no table
  // declared, so a hand-made override must not count as a declaration.
  it('does not record a retention class set by redefining the column', () => {
    expect(getTableColumns(overridden).retentionClass.default).toBe('contract');
    expect(declaredRetentionClasses().has('probe_overridden')).toBe(false);
  });
});

// Probe security tables, built the way the login tables are.
const securityDeclared = securityTable('probe_security_declared', {
  ...baseColumns(() => user.id, { defaultRetentionClass: 'security-log' }),
  note: text('note'),
});
const securityPlain = securityTable('probe_security_plain', {
  ...baseColumns(() => user.id),
});
// A CHECK named after a column of the table proves `extraConfig` ran and saw
// the table's own columns.
const securityExtra = securityTable(
  'probe_security_extra',
  { ...baseColumns(() => user.id), note: text('note') },
  (t) => [check(`probe_security_extra_${t.note.name}_check`, sql`true`)],
);

describe('securityTable', () => {
  it('records its name, and no tenant table is recorded as a security table', () => {
    expect(securityTableNames().has('probe_security_declared')).toBe(true);
    expect(securityTableNames().has('probe_security_plain')).toBe(true);
    expect(securityTableNames().has('probe_declared')).toBe(false);
    expect(tenantTableNames().has('probe_security_declared')).toBe(false);
  });

  it('sets the retention class default and records the declaration, like tenantTable', () => {
    expect(getTableColumns(securityDeclared).retentionClass.default).toBe(
      'security-log',
    );
    expect(declaredRetentionClasses().get('probe_security_declared')).toBe(
      'security-log',
    );
    expect(getTableColumns(securityPlain).retentionClass.default).toBe(
      'standard',
    );
    expect(declaredRetentionClasses().has('probe_security_plain')).toBe(false);
  });

  it('adds the retention class foreign key under its standard name', () => {
    for (const table of [securityDeclared, securityPlain]) {
      const config = getTableConfig(table);
      expect(config.foreignKeys.map((fk) => fk.getName())).toContain(
        retentionClassForeignKeyName(config.name),
      );
    }
  });

  it('keeps the table’s own extra configuration', () => {
    expect(getTableConfig(securityExtra).checks.map((c) => c.name)).toEqual([
      'probe_security_extra_note_check',
    ]);
  });
});

// Probe tables for the declared exception: a security table that carries
// `organisation_id`, and a child table of one. Their own names, so they never
// reach `schema.test.ts`.
const scoped = securityTable(
  'probe_security_scoped',
  {
    ...baseColumns(() => user.id),
    organisationId: uuid('organisation_id').notNull(),
  },
  undefined,
  {
    organisationScoped: {
      organisationId: () => organisation.id,
      reason: 'A probe whose rows belong to one organisation',
    },
  },
);
const child = securityChildTable(
  'probe_security_child',
  {
    organisationId: uuid('organisation_id').notNull(),
    scopedId: uuid('scoped_id').notNull(),
  },
  (t) => [check(`probe_security_child_${t.scopedId.name}_check`, sql`true`)],
  {
    organisationId: () => organisation.id,
    parent: 'probe_security_scoped',
    reason: 'It has no retention class of its own: it goes with its parent row',
  },
);

describe('securityTable with organisationScoped', () => {
  it('records the table and the reason it declared, and it stays a security table, not a tenant table', () => {
    expect(
      organisationScopedSecurityTables().get('probe_security_scoped'),
    ).toBe('A probe whose rows belong to one organisation');
    expect(securityTableNames().has('probe_security_scoped')).toBe(true);
    expect(tenantTableNames().has('probe_security_scoped')).toBe(false);
  });

  it('records no table that did not declare it', () => {
    expect(organisationScopedSecurityTables().has('probe_security_plain')).toBe(
      false,
    );
    expect(organisationScopedSecurityTables().has('probe_security_child')).toBe(
      false,
    );
  });

  it('adds the organisation foreign key under the name every table with an organisation_id uses', () => {
    expect(
      getTableConfig(scoped).foreignKeys.map((fk) => fk.getName()),
    ).toContain('probe_security_scoped_organisation_fk');
  });

  it('refuses a table that declares it without an organisationId column, or without a reason', () => {
    expect(() =>
      securityTable(
        'probe_security_missing_column',
        { ...baseColumns(() => user.id) },
        undefined,
        {
          organisationScoped: {
            organisationId: () => organisation.id,
            reason: 'No column',
          },
        },
      ),
    ).toThrow(/organisationId/);
    expect(() =>
      securityTable(
        'probe_security_no_reason',
        {
          ...baseColumns(() => user.id),
          organisationId: uuid('organisation_id').notNull(),
        },
        undefined,
        {
          organisationScoped: {
            organisationId: () => organisation.id,
            reason: '  ',
          },
        },
      ),
    ).toThrow(/reason/);
  });
});

describe('securityChildTable', () => {
  it('records the table with its parent and its reason, and it is neither a security table nor a tenant table', () => {
    expect(securityChildTables().get('probe_security_child')).toEqual({
      parent: 'probe_security_scoped',
      reason:
        'It has no retention class of its own: it goes with its parent row',
    });
    expect(securityTableNames().has('probe_security_child')).toBe(false);
    expect(tenantTableNames().has('probe_security_child')).toBe(false);
  });

  it('adds the organisation foreign key and keeps the table’s own extra configuration', () => {
    const config = getTableConfig(child);
    expect(config.foreignKeys.map((fk) => fk.getName())).toEqual([
      'probe_security_child_organisation_fk',
    ]);
    expect(config.checks.map((c) => c.name)).toEqual([
      'probe_security_child_scoped_id_check',
    ]);
  });

  it('has no retention class column: its rows go with the parent’s', () => {
    expect(Object.keys(getTableColumns(child)).sort()).toEqual([
      'organisationId',
      'scopedId',
    ]);
    expect(declaredRetentionClasses().has('probe_security_child')).toBe(false);
  });

  it('refuses a table without an organisationId column, or without a reason', () => {
    expect(() =>
      securityChildTable(
        'probe_child_missing_column',
        { scopedId: uuid('scoped_id').notNull() },
        undefined,
        { organisationId: () => organisation.id, parent: 'x', reason: 'r' },
      ),
    ).toThrow(/organisationId/);
    expect(() =>
      securityChildTable(
        'probe_child_no_reason',
        { organisationId: uuid('organisation_id').notNull() },
        undefined,
        { organisationId: () => organisation.id, parent: 'x', reason: '' },
      ),
    ).toThrow(/reason/);
  });
});

describe('isSecurityTableName', () => {
  it('is true for a security table and for the child table of one, and false for a tenant table or an unknown name', () => {
    expect(isSecurityTableName('probe_security_plain')).toBe(true);
    expect(isSecurityTableName('probe_security_scoped')).toBe(true);
    expect(isSecurityTableName('probe_security_child')).toBe(true);
    expect(isSecurityTableName('probe_plain')).toBe(false);
    expect(isSecurityTableName('no_such_table')).toBe(false);
  });
});

// Probe tables for the registry of who writes a table. Their own names, so they
// never reach `schema.test.ts`.
const REASON = 'A probe that the sensitive service writes';
const writerDefault = securityTable('probe_writer_default', {
  ...baseColumns(() => user.id),
});
const writerOther = securityTable(
  'probe_writer_other',
  { ...baseColumns(() => user.id) },
  undefined,
  { writtenBy: { service: 'sensitive', reason: `  ${REASON}  ` } },
);
const probe = (name: string) => pgTable(name, { id: uuid('id').primaryKey() });
const serviceDefault = declareServiceWrittenTable(
  probe('probe_service_default'),
  { service: DEFAULT_TABLE_WRITER },
);
const serviceOther = declareServiceWrittenTable(probe('probe_service_other'), {
  service: 'sensitive',
  reason: REASON,
});

describe('the registry of who writes a table', () => {
  it('names the auth service for a security table that declares nothing, with no reason', () => {
    expect(DEFAULT_TABLE_WRITER).toBe('auth');
    expect(tableWriters().get('probe_writer_default')).toEqual({
      kind: 'security',
      service: 'auth',
      reason: null,
    });
    expect(getTableConfig(writerDefault).name).toBe('probe_writer_default');
  });

  it('records the folder and the trimmed one-line reason a security table declared', () => {
    expect(tableWriters().get('probe_writer_other')).toEqual({
      kind: 'security',
      service: 'sensitive',
      reason: REASON,
    });
    // It is still a security table in every other way.
    expect(securityTableNames().has('probe_writer_other')).toBe(true);
    expect(
      getTableConfig(writerOther).foreignKeys.map((fk) => fk.getName()),
    ).toContain(retentionClassForeignKeyName('probe_writer_other'));
  });

  it('records a service-written table the same way, hands the table back and lists its name', () => {
    expect(getTableConfig(serviceDefault).name).toBe('probe_service_default');
    expect(tableWriters().get('probe_service_default')).toEqual({
      kind: 'service-written',
      service: 'auth',
      reason: null,
    });
    expect(tableWriters().get('probe_service_other')).toEqual({
      kind: 'service-written',
      service: 'sensitive',
      reason: REASON,
    });
    expect(serviceWrittenTableNames().has('probe_service_default')).toBe(true);
    expect(serviceWrittenTableNames().has('probe_service_other')).toBe(true);
    // A security table is not a service-written one, whoever writes it.
    expect(serviceWrittenTableNames().has('probe_writer_default')).toBe(false);
    expect(serviceWrittenTableNames().has('probe_writer_other')).toBe(false);
    expect(securityTableNames().has('probe_service_other')).toBe(false);
    expect(tenantTableNames().has('probe_service_other')).toBe(false);
  });

  it('records no tenant table, no child table and no table nobody declared', () => {
    expect(tableWriters().has('probe_plain')).toBe(false);
    expect(tableWriters().has('probe_security_child')).toBe(false);
    expect(tableWriters().has('no_such_table')).toBe(false);
  });

  it('ignores a reason given for the default writer', () => {
    const table = declareServiceWrittenTable(probe('probe_service_noted'), {
      service: 'auth',
      reason: 'Not needed for the default',
    });
    expect(getTableConfig(table).name).toBe('probe_service_noted');
    expect(tableWriters().get('probe_service_noted')?.reason).toBeNull();
  });

  it('refuses a writer other than the default with no reason, or one of more than a line, and leaves no trace', () => {
    for (const reason of [undefined, '', '   ', 'one line\nand another']) {
      expect(() =>
        securityTable(
          'probe_writer_refused',
          { ...baseColumns(() => user.id) },
          undefined,
          {
            writtenBy: {
              service: 'sensitive',
              ...(reason === undefined ? {} : { reason }),
            },
          },
        ),
      ).toThrow(/reason|more than one line/);
      expect(() =>
        declareServiceWrittenTable(probe('probe_writer_refused'), {
          service: 'sensitive',
          ...(reason === undefined ? {} : { reason }),
        }),
      ).toThrow(/reason|more than one line/);
    }
    expect(tableWriters().has('probe_writer_refused')).toBe(false);
    expect(securityTableNames().has('probe_writer_refused')).toBe(false);
  });

  it('refuses a writer that is not the name of a folder', () => {
    for (const service of [
      '',
      'Sensitive',
      '../auth',
      'a/b',
      'a b',
      'auth.',
      '1auth',
      '-auth',
    ]) {
      expect(() =>
        declareServiceWrittenTable(probe('probe_writer_folder'), {
          service,
          reason: REASON,
        }),
      ).toThrow(/folder name/);
    }
    expect(tableWriters().has('probe_writer_folder')).toBe(false);
  });

  it('refuses a tenant table, and a table that already has a different writer', () => {
    expect(() =>
      declareServiceWrittenTable(declared, { service: 'auth' }),
    ).toThrow(/tenant table/);
    expect(() =>
      declareServiceWrittenTable(serviceDefault, {
        service: 'sensitive',
        reason: REASON,
      }),
    ).toThrow(/different writer/);
    // The same declaration again is no change, so it is accepted.
    expect(
      declareServiceWrittenTable(serviceOther, {
        service: 'sensitive',
        reason: REASON,
      }),
    ).toBe(serviceOther);
    // The same name as a security table, written as a service-written one.
    expect(() =>
      declareServiceWrittenTable(probe('probe_writer_default'), {
        service: 'auth',
      }),
    ).toThrow(/different writer/);
  });
});
