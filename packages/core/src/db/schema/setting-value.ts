import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, visibilityCheck } from '../columns.js';
import { project } from './project.js';
import { user } from './user.js';

export const SETTING_LAYERS = ['org', 'project'] as const;
export type SettingLayer = (typeof SETTING_LAYERS)[number];

/**
 * A setting stored at the organisation or project layer. Install-level
 * defaults ship in code (module contracts), so they are not stored here.
 */
export const settingValue = pgTable(
  'setting_value',
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
    visibilityCheck('setting_value', t.visibility),
  ],
);
