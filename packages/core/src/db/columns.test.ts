import { getTableColumns, sql } from 'drizzle-orm';
import { check, getTableConfig, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  baseColumns,
  declaredRetentionClasses,
  retentionClassForeignKeyName,
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
