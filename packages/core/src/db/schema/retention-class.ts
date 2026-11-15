import { sql } from 'drizzle-orm';
import { check, pgTable, text } from 'drizzle-orm/pg-core';
import { sqlList } from '../sql-list.js';

/** The event a retention period counts from. */
export const RETENTION_ANCHORS = [
  'record-created',
  'project-wrap',
  'project-delivery',
  'first-exploitation',
  'last-activity',
] as const;
/** One value of `RETENTION_ANCHORS`. */
export type RetentionAnchor = (typeof RETENTION_ANCHORS)[number];

/**
 * Install-level catalogue of retention classes. Every record points to one
 * through `retention_class`. The list is fixed and seeded by a migration; the
 * periods that go with each class are data, not part of this table. Not
 * tenant-scoped, so it carries no standard columns.
 */
export const retentionClass = pgTable(
  'retention_class',
  {
    key: text('key').primaryKey(),
    description: text('description').notNull(),
    anchor: text('anchor').$type<RetentionAnchor>().notNull(),
  },
  (t) => [
    check(
      'retention_class_anchor_check',
      sql`${t.anchor} in (${sqlList(RETENTION_ANCHORS)})`,
    ),
  ],
);
