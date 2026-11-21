import { and, eq, sql } from 'drizzle-orm';
import { check, foreignKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { registerProjectResolver } from '../project-resolver.js';
import { department } from './department.js';
import { permission } from './permission.js';
import { role } from './role.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

/**
 * Allowed values of `role_permission.reach`. The CHECK is built from this list,
 * so a new value needs a new migration.
 *
 * - `own-scope`: the grant applies where the role lives. A project role's grant
 *   applies on its project; an organisation role's grant applies at
 *   organisation level only.
 * - `all-projects`: only on an organisation role. The grant also applies in
 *   every project of the organisation (see `hasProjectPermission`).
 *
 * Rules the database enforces, with the decision they come from: no
 * department scope on an `all-projects` grant, only organisation roles may hold
 * one, and a permission with `grants_sensitive` can never be reached into all
 * projects (maintainer decision of 21 Nov, task P-02k; CLAUDE.md, Privacy rule).
 */
export const ROLE_PERMISSION_REACHES = ['own-scope', 'all-projects'] as const;
/** One value of `ROLE_PERMISSION_REACHES`. */
export type RolePermissionReach = (typeof ROLE_PERMISSION_REACHES)[number];

/**
 * Grants a permission to a role, optionally limited to one department, with a
 * `reach` that says whether an organisation role's grant also applies in every
 * project of the organisation. Two database triggers enforce that only an
 * organisation role holds an `all-projects` grant and that its permission is
 * not sensitive; they are hand-written SQL (see `0023_role_permission_reach.sql`).
 */
export const rolePermission = tenantTable(
  'role_permission',
  () => organisation.id,
  {
    ...standardColumns(() => user.id),
    roleId: uuid('role_id').notNull(),
    permissionKey: text('permission_key').notNull(),
    departmentId: uuid('department_id'),
    reach: text('reach')
      .$type<RolePermissionReach>()
      .notNull()
      .default('own-scope'),
  },
  (t) => [
    check(
      'role_permission_reach_check',
      sql`${t.reach} in (${sqlList(ROLE_PERMISSION_REACHES)})`,
    ),
    // A studio-wide grant is not tied to a department.
    check(
      'role_permission_all_projects_no_department_check',
      sql`${t.reach} = 'own-scope' or ${t.departmentId} is null`,
    ),
    foreignKey({
      name: 'role_permission_role_fk',
      columns: [t.organisationId, t.roleId],
      foreignColumns: [role.organisationId, role.id],
    }),
    foreignKey({
      name: 'role_permission_permission_key_fk',
      columns: [t.permissionKey],
      foreignColumns: [permission.key],
    }),
    foreignKey({
      name: 'role_permission_department_fk',
      columns: [t.organisationId, t.departmentId],
      foreignColumns: [department.organisationId, department.id],
    }),
    // NULLS NOT DISTINCT: a grant with no department is not limited to one,
    // and a plain UNIQUE would let it repeat.
    unique('role_permission_role_permission_department_unique')
      .on(t.roleId, t.permissionKey, t.departmentId)
      .nullsNotDistinct(),
  ],
);

/**
 * Has no `project_id`: its project is its role's. An organisation template
 * role has none, so its permissions belong to the organisation sequence.
 */
registerProjectResolver(
  rolePermission,
  async (tx, row) => {
    const [found] = await tx
      .select({ projectId: role.projectId })
      .from(role)
      .where(
        and(
          eq(role.id, row.roleId as string),
          eq(role.organisationId, row.organisationId as string),
        ),
      )
      .limit(1);
    return found?.projectId ?? null;
  },
  { parentKeys: ['roleId'] },
);
