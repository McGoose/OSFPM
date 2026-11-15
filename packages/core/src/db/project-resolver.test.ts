import { pgTable, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  declareOrganisationLevel,
  hasProjectResolver,
  isOrganisationLevel,
  registerProjectResolver,
} from './project-resolver.js';

// Plain tables, so nothing here touches the tenant table registry.
const probe = (name: string) => pgTable(name, { id: uuid('id').primaryKey() });

describe('declareOrganisationLevel', () => {
  it('marks the table organisation-level and leaves it without a resolver', () => {
    const table = probe('probe_declared');
    expect(isOrganisationLevel(table)).toBe(false);
    declareOrganisationLevel(table);
    expect(isOrganisationLevel(table)).toBe(true);
    expect(hasProjectResolver(table)).toBe(false);
  });

  it('marks only the table it was called for', () => {
    const declared = probe('probe_declared_alone');
    const other = probe('probe_other');
    declareOrganisationLevel(declared);
    expect(isOrganisationLevel(other)).toBe(false);
  });

  it('refuses a table that already has a project resolver', () => {
    const table = probe('probe_resolved_first');
    registerProjectResolver(table, () => Promise.resolve(null));
    expect(() => declareOrganisationLevel(table)).toThrow(
      /probe_resolved_first.*project resolver/,
    );
    expect(isOrganisationLevel(table)).toBe(false);
  });

  it('makes registering a project resolver for the table fail', () => {
    const table = probe('probe_declared_first');
    declareOrganisationLevel(table);
    expect(() =>
      registerProjectResolver(table, () => Promise.resolve(null)),
    ).toThrow(/probe_declared_first.*organisation-level/);
    expect(hasProjectResolver(table)).toBe(false);
  });
});

describe('hasProjectResolver', () => {
  it('is true once a resolver is registered, and only for that table', () => {
    const table = probe('probe_resolver');
    const other = probe('probe_no_resolver');
    expect(hasProjectResolver(table)).toBe(false);
    registerProjectResolver(table, () => Promise.resolve(null));
    expect(hasProjectResolver(table)).toBe(true);
    expect(hasProjectResolver(other)).toBe(false);
  });
});
