import { sql } from 'drizzle-orm';
import { check, foreignKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { standardColumns, tenantTable } from '../columns.js';
import { registerProjectResolver } from '../project-resolver.js';
import { company } from './company.js';
import { contract, contractProjectResolver } from './contract.js';
import { organisation } from './organisation.js';
import { person } from './person.js';
import { user } from './user.js';

/**
 * A party to a contract: one person or one company, in a role such as
 * `artist`, `producer` or `licensor`. The same party may appear in several
 * roles. Visibility defaults to `private` and the retention class to
 * `contract`.
 */
export const contractParty = tenantTable(
  'contract_party',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, {
      defaultVisibility: 'private',
      defaultRetentionClass: 'contract',
    }),
    contractId: uuid('contract_id').notNull(),
    personId: uuid('person_id'),
    companyId: uuid('company_id'),
    partyRole: text('party_role').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'contract_party_contract_fk',
      columns: [t.organisationId, t.contractId],
      foreignColumns: [contract.organisationId, contract.id],
    }),
    foreignKey({
      name: 'contract_party_person_fk',
      columns: [t.organisationId, t.personId],
      foreignColumns: [person.organisationId, person.id],
    }),
    foreignKey({
      name: 'contract_party_company_fk',
      columns: [t.organisationId, t.companyId],
      foreignColumns: [company.organisationId, company.id],
    }),
    check(
      'contract_party_one_party_check',
      sql`(${t.personId} is null) <> (${t.companyId} is null)`,
    ),
    // NULLS NOT DISTINCT: a party is a person or a company, so one of the two
    // is always NULL, and a plain UNIQUE would let a company repeat a role.
    unique('contract_party_contract_person_company_role_unique')
      .on(t.contractId, t.personId, t.companyId, t.partyRole)
      .nullsNotDistinct(),
  ],
);

/** Has no `project_id`: its project is the one its contract belongs to. */
registerProjectResolver(contractParty, contractProjectResolver, {
  parentKeys: ['contractId'],
});
