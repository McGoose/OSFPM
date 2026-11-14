import { and, eq } from 'drizzle-orm';
import { foreignKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { standardColumns, tenantTable } from '../columns.js';
import { registerProjectResolver } from '../project-resolver.js';
import { department } from './department.js';
import { permission } from './permission.js';
import { role } from './role.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

/** Grants a permission to a role, optionally limited to one department. */
export const rolePermission = tenantTable(
  'role_permission',
  () => organisation.id,
  {
    ...standardColumns(() => user.id),
    roleId: uuid('role_id').notNull(),
    permissionKey: text('permission_key').notNull(),
    departmentId: uuid('department_id'),
  },
  (t) => [
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
