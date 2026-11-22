# access

Permission checks and the error a denied call throws. They run on the server only, never on a client.

**Entry points**

- `hasProjectPermission`, `hasOrganisationPermission` and `hasScopedPermission` return true or false for a user, a scope and a permission key.
- `AccessDeniedError` is thrown by a service for a denied call. The layer above maps it to a 403.
- `PERMISSION_LISTS` (`permission-lists.ts`) is the one registry of every permission list a module declares. A module that adds a `*_PERMISSIONS` list adds it there; `permission-lists.test.ts` scans the core and fails when one is missing.
- `syncPermissions` and `PermissionDefinition` fill the `permission` catalogue from the keys a module declares. The API server calls it for every list in `PERMISSION_LISTS` when it starts (`packages/api/src/startup.ts`). It throws `PermissionSyncError` when a key is flagged sensitive while organisation roles hold `all-projects` grants of it (see below).
- `test-fixtures.ts` seeds organisations, users and grants for tests, using invented people from _The Last Withdrawal_.
- First-run setup makes the Administrator role (`createAdministratorRole`, `src/auth/administrator-role.ts`): every permission in `PERMISSION_LISTS`, a sensitive one in its own scope and every other to all projects, so the administrator is the one organisation role that reaches every project for ordinary data and still needs membership for sensitive data. The server tops it up with the permissions a later release declares each time it starts (`topUpAdministratorRoles`).
- `managed-role.ts` is what makes that role managed: `ManagedRoleError`, the guards `assertRoleEditable` and `assertGrantEditable`, and `withManagedRoleMaintenance`, the one way the server writes to a managed role (see below).

**Organisation roles in projects**

Each grant on a role (`role_permission.reach`) says where it applies. The organisation chooses this per permission:

- `own-scope` (the default) applies where the role lives. A project role's grant applies on its project, and an organisation role's grant at organisation level only.
- `all-projects` is only for organisation roles. The grant applies at organisation level and also in every live project of the organisation, with no project membership needed.

`hasOrganisationPermission` counts both reaches. `hasProjectPermission` counts a project membership as before, and also an `all-projects` grant held through an active, undeleted organisation membership, a live link and a live organisation role. A soft-deleted project is not reached.

The database enforces the limits, all with SQLSTATE `23514` and the name in the message:

- `role_permission_all_projects_no_department_check`: an `all-projects` grant has no department.
- `role_permission_all_projects_org_role_only`: an `all-projects` grant needs an organisation role. A role that has such a grant, deleted ones included, cannot become a project role.
- `role_permission_all_projects_not_sensitive`: an `all-projects` grant needs a permission that is not `grants_sensitive`. A permission with such a grant cannot be flagged sensitive, so `syncPermissions` throws `PermissionSyncError` if a module flags one while grants of it exist. The error names the permission key and the organisation roles (organisation id and role key) and nothing from the list is written. Remove those grants, then restart. A soft-deleted grant still counts: change its reach to `own-scope` or delete the row.

**Managed roles** (`role.managed`, migration `0031_role_managed.sql`)

A managed role is one the server makes and keeps: the Administrator role. An organisation cannot edit or delete it, or give, change or take away its permissions, because a role that the people it governs can edit could be emptied or deleted, and the organisation would have no one left who can do anything.

- **The service guard.** A service that edits or deletes a role calls `assertRoleEditable(tx, roleId)` first, and one that changes or removes a grant calls `assertGrantEditable(tx, grantId)`; to give a role a new grant, it checks the role. Both throw `ManagedRoleError` (the API answers a 409 `role-managed`) and pass for a role or grant that is not there. They read without a lock: a role's flag never changes, and a lock taken before the write helper takes the organisation's change counter would reverse the lock order.
- **The database trigger** refuses the write when a caller skipped the guard, with SQLSTATE `23514` and the constraint name: `role_managed_system_only` (a managed role made by anyone but the server), `role_managed_no_change` (any change to a managed role, a rename or a soft delete included, a delete, and making a role managed or ordinary) and `role_permission_managed_no_change` (a grant added to, changed on, moved on or off, or deleted from a managed role). The messages carry no ids or values.
- **The server's own writes** run inside `withManagedRoleMaintenance(tx, work)`, which sets a transaction-local setting the triggers read, runs `work` with the handle it is given, and puts the setting back, so the rest of the transaction is checked again. Only `createAdministratorRole` and `topUpAdministratorRoles` use it. A request must never reach it.

**Rules you must not break**

- A managed role and its grants change only inside `withManagedRoleMaintenance`. A new service that edits roles calls the guards.
- A project role grants nothing in the organisation. An organisation role grants nothing on a project unless the grant has `reach = 'all-projects'`.
- A permission flagged `grantsSensitive` never reaches all projects. Sensitive access always needs project membership. `hasProjectPermission` ignores an `all-projects` grant of such a permission even if one got into the database. This is the privacy rule: sensitive data goes only to those who need it.
- `org_membership.org_role` (owner, admin and so on) grants nothing by itself. Only a role linked to the membership does.
- Only `active` memberships and undeleted rows count. Invited, removed and other organisations' members hold nothing.
- Pass a scope to `AccessDeniedError` only when the caller named it, as a create or a list does. A call by id leaves it out, so an unknown id is refused like a forbidden one.
- Flag a permission `grantsSensitive` when it exposes sensitive data.

**Tests:** `permission-lists.test.ts` (the registry holds every declared list, no key twice), `permissions.test.ts` (`syncPermissions`, including `PermissionSyncError`, and `hasProjectPermission` through project membership), `project-permission-reach.test.ts` (organisation roles in projects), `reach-concurrency.test.ts` (an all-projects grant racing the sensitive flag on two real connections; PostgreSQL only, skipped on PGlite), `managed-role.test.ts` (the triggers, the guards and the maintenance switch), `organisation-permission.test.ts`, `scoped-permission.test.ts` and `access-denied-error.test.ts`. The `reach` constraints and triggers are tested in `src/db/schema.test.ts`, and `src/accounts/organisation-role-reach.test.ts` goes through a real service.
