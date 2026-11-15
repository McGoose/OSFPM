import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  inet,
  jsonb,
  pgTable,
  text,
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
 * Append-only security log (sign-ins, permission changes, exports, and so on).
 * Same exception to the standard columns as `change_event`. Written through
 * `recordAudit`; a database trigger refuses UPDATE, DELETE and TRUNCATE (see
 * `appendOnlyMigrationSql`). `details` must never hold sensitive values
 * (CLAUDE.md, Data rules).
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    organisationId: uuid('organisation_id'),
    projectId: uuid('project_id'),
    category: text('category').notNull(),
    action: text('action').notNull(),
    actorType: text('actor_type').$type<ActorType>().notNull(),
    actorId: uuid('actor_id'),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    details: jsonb('details').$type<Record<string, unknown>>(),
    ipAddress: inet('ip_address'),
    requestId: text('request_id'),
    occurredAt: timestamptz('occurred_at').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'audit_event_organisation_fk',
      columns: [t.organisationId],
      foreignColumns: [organisation.id],
    }),
    foreignKey({
      name: 'audit_event_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    index('audit_event_organisation_occurred_idx').on(
      t.organisationId,
      t.occurredAt,
    ),
    check(
      'audit_event_project_requires_organisation_check',
      sql`${t.projectId} is null or ${t.organisationId} is not null`,
    ),
    check(
      'audit_event_actor_type_check',
      sql`${t.actorType} in (${sqlList(ACTOR_TYPES)})`,
    ),
  ],
);
