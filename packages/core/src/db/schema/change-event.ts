import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  ACTOR_TYPES,
  sqlList,
  timestamptz,
  type ActorType,
} from '../columns.js';
import { newId } from '../ids.js';
import { organisation } from './organisation.js';
import { project } from './project.js';

/**
 * Allowed values of `change_event.action`. The CHECK is built from this list,
 * so a new value needs a new migration.
 */
export const CHANGE_ACTIONS = [
  'create',
  'update',
  'delete',
  'restore',
] as const;
/** One value of `CHANGE_ACTIONS`. */
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

/**
 * Append-only change feed: one row per write to a tenant record. Used for
 * history, webhooks and offline sync. Exception to the standard columns: it is
 * never updated or deleted, so it has no `version`, `updated_*`, `deleted_*`,
 * `visibility`, `owner_org_id` or `retention_class`. Written only by the write
 * helper, one event per write; a database trigger refuses UPDATE, DELETE and
 * TRUNCATE (see `appendOnlyMigrationSql`).
 *
 * `before` and `after` omit sensitive fields; their names stay in
 * `changed_fields`, their values are never stored (CLAUDE.md, Data rules).
 */
export const changeEvent = pgTable(
  'change_event',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    organisationId: uuid('organisation_id').notNull(),
    projectId: uuid('project_id'),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: text('action').$type<ChangeAction>().notNull(),
    changedFields: text('changed_fields').array().notNull(),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    entityVersion: integer('entity_version').notNull(),
    actorType: text('actor_type').$type<ActorType>().notNull(),
    actorId: uuid('actor_id'),
    requestId: text('request_id'),
    originServer: uuid('origin_server').notNull(),
    occurredAt: timestamptz('occurred_at').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'change_event_organisation_fk',
      columns: [t.organisationId],
      foreignColumns: [organisation.id],
    }),
    foreignKey({
      name: 'change_event_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    // NULLS NOT DISTINCT: organisation-level events have a NULL project, and
    // their numbers must not repeat either.
    unique('change_event_organisation_project_seq_unique')
      .on(t.organisationId, t.projectId, t.seq)
      .nullsNotDistinct(),
    index('change_event_entity_idx').on(t.entityType, t.entityId),
    check(
      'change_event_action_check',
      sql`${t.action} in (${sqlList(CHANGE_ACTIONS)})`,
    ),
    check(
      'change_event_actor_type_check',
      sql`${t.actorType} in (${sqlList(ACTOR_TYPES)})`,
    ),
  ],
);
