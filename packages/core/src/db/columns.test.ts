import { getTableColumns, sql } from 'drizzle-orm';
import { check, getTableConfig, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  baseColumns,
  declaredRetentionClasses,
  isSecurityTableName,
  organisationScopedSecurityTables,
  retentionClassForeignKeyName,
  securityChildTable,
  securityChildTables,
  securityTable,
  securityTableNames,
  standardColumns,
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
