import { foreignKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { standardColumns, tenantTable, visibilityCheck } from '../columns.js';
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
    visibilityCheck('role_permission', t.visibility),
  ],
);
