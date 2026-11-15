import { sql } from 'drizzle-orm';
import { check, foreignKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { registerProjectResolver } from '../project-resolver.js';
import { contract, contractProjectResolver } from './contract.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

export const CONTRACT_LINK_ENTITY_TYPES = [
  'project',
  'person',
  'company',
  'location',
  'unit',
  'episode',
] as const;
export type ContractLinkEntityType =
  (typeof CONTRACT_LINK_ENTITY_TYPES)[number];

/**
 * A record a contract concerns: the project it is for, a person or company it
 * is about, the location it covers, a unit or an episode. `entity_id` points
 * at a row of the table `entity_type` names, which is several tables, so no
 * foreign key can hold it; the service layer checks that the target exists,
 * is not deleted and is in the same organisation. Visibility defaults to
 * `private` and the retention class to `contract`.
 */
export const contractLink = tenantTable(
  'contract_link',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, {
      defaultVisibility: 'private',
      defaultRetentionClass: 'contract',
    }),
    contractId: uuid('contract_id').notNull(),
    entityType: text('entity_type').$type<ContractLinkEntityType>().notNull(),
    entityId: uuid('entity_id').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'contract_link_contract_fk',
      columns: [t.organisationId, t.contractId],
      foreignColumns: [contract.organisationId, contract.id],
    }),
    check(
      'contract_link_entity_type_check',
      sql`${t.entityType} in (${sqlList(CONTRACT_LINK_ENTITY_TYPES)})`,
    ),
    unique('contract_link_contract_entity_type_entity_unique').on(
      t.contractId,
      t.entityType,
      t.entityId,
    ),
  ],
);

/** Has no `project_id`: its project is the one its contract belongs to. */
registerProjectResolver(contractLink, contractProjectResolver, {
  parentKeys: ['contractId'],
});
