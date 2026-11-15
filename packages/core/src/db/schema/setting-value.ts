import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  jsonb,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { project } from './project.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

/**
 * Allowed values of `setting_value.layer`. The CHECK is built from this list,
 * so a new value needs a new migration.
 *
 * An `org` row has no project and a `project` row has one; a CHECK enforces it.
 */
export const SETTING_LAYERS = ['org', 'project'] as const;
/** One value of `SETTING_LAYERS`. */
export type SettingLayer = (typeof SETTING_LAYERS)[number];

/**
 * A setting stored at the organisation or project layer. Install-level
 * defaults ship in code (module contracts), so they are not stored here.
 */
export const settingValue = tenantTable(
  'setting_value',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, { defaultVisibility: 'private' }),
    layer: text('layer').$type<SettingLayer>().notNull(),
    projectId: uuid('project_id'),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'setting_value_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    // NULLS NOT DISTINCT: the org layer has a NULL project, and a plain UNIQUE
    // would let the same key repeat at that layer.
    unique('setting_value_organisation_project_key_unique')
      .on(t.organisationId, t.projectId, t.key)
      .nullsNotDistinct(),
    check(
      'setting_value_layer_check',
      sql`${t.layer} in (${sqlList(SETTING_LAYERS)})`,
    ),
    check(
      'setting_value_layer_project_check',
      sql`(${t.layer} = 'org' and ${t.projectId} is null) or (${t.layer} = 'project' and ${t.projectId} is not null)`,
    ),
  ],
);
