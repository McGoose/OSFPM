import { getTableColumns } from 'drizzle-orm';
import { text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  declaredRetentionClasses,
  standardColumns,
  tenantTable,
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
