import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { organisation } from './organisation.js';
import { project } from './project.js';
import { user } from './user.js';

export const UNIT_KINDS = [
  'main',
  'second',
  'splinter',
  'vfx',
  'other',
] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** A shooting unit of one project: the main unit, a second unit and so on. */
export const unit = tenantTable(
  'unit',
  () => organisation.id,
  {
    ...standardColumns(() => user.id),
    projectId: uuid('project_id').notNull(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<UnitKind>().notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'unit_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    // Target for composite tenant foreign keys in later tables.
    unique('unit_organisation_id_id_unique').on(t.organisationId, t.id),
    unique('unit_project_key_unique').on(t.projectId, t.key),
    // At most one live main unit per project; a deleted one frees the slot.
    uniqueIndex('unit_project_main_unique')
      .on(t.projectId)
      .where(sql`${t.kind} = 'main' and ${t.deletedAt} is null`),
    check('unit_kind_check', sql`${t.kind} in (${sqlList(UNIT_KINDS)})`),
  ],
);
