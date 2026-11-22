# access

Permission checks and the error a denied call throws. They run on the server only, never on a client.

**Entry points**

- `hasProjectPermission`, `hasOrganisationPermission` and `hasScopedPermission` return true or false for a user, a scope and a permission key.
- `AccessDeniedError` is thrown by a service for a denied call. The layer above maps it to a 403.
- `PERMISSION_LISTS` (`permission-lists.ts`) is the one registry of every permission list a module declares. A module that adds a `*_PERMISSIONS` list adds it there; `permission-lists.test.ts` scans the core and fails when one is missing.
- `syncPermissions` and `PermissionDefinition` fill the `permission` catalogue from the keys a module declares. The API server calls it for every list in `PERMISSION_LISTS` when it starts (`packages/api/src/startup.ts`). It throws `PermissionSyncError` when a key is flagged sensitive while organisation roles hold `all-projects` grants of it (see below).
- `test-fixtures.ts` seeds organisations, users and grants for tests, using invented people from _The Last Withdrawal_.
- First-run setup makes the Administrator role (`createAdministratorRole`, `src/auth/administrator-role.ts`): every permission in `PERMISSION_LISTS`, a sensitive one in its own scope and every other to all projects, so the administrator is the one organisation role that reaches every project for ordinary data and still needs membership for sensitive data.

**Organisation roles in projects**

Each grant on a role (`role_permission.reach`) says where it applies. The organisation chooses this per permission:

- `own-scope` (the default) applies where the role lives. A project role's grant applies on its project, and an organisation role's grant at organisation level only.
- `all-projects` is only for organisation roles. The grant applies at organisation level and also in every live project of the organisation, with no project membership needed.

`hasOrganisationPermission` counts both reaches. `hasProjectPermission` counts a project membership as before, and also an `all-projects` grant held through an active, undeleted organisation membership, a live link and a live organisation role. A soft-deleted project is not reached.

The database enforces the limits, all with SQLSTATE `23514` and the name in the message:

- `role_permission_all_projects_no_department_check`: an `all-projects` grant has no department.
- `role_permission_all_projects_org_role_only`: an `all-projects` grant needs an organisation role. A role that has such a grant, deleted ones included, cannot become a project role.
- `role_permission_all_projects_not_sensitive`: an `all-projects` grant needs a permission that is not `grants_sensitive`. A permission with such a grant cannot be flagged sensitive, so `syncPermissions` throws `PermissionSyncError` if a module flags one while grants of it exist. The error names the permission key and the organisation roles (organisation id and role key) and nothing from the list is written. Remove those grants, then restart. A soft-deleted grant still counts: change its reach to `own-scope` or delete the row.

**Rules you must not break**

- A project role grants nothing in the organisation. An organisation role grants nothing on a project unless the grant has `reach = 'all-projects'`.
- A permission flagged `grantsSensitive` never reaches all projects. Sensitive access always needs project membership. `hasProjectPermission` ignores an `all-projects` grant of such a permission even if one got into the database. This is the privacy rule: sensitive data goes only to those who need it.
- `org_membership.org_role` (owner, admin and so on) grants nothing by itself. Only a role linked to the membership does.
- Only `active` memberships and undeleted rows count. Invited, removed and other organisations' members hold nothing.
- Pass a scope to `AccessDeniedError` only when the caller named it, as a create or a list does. A call by id leaves it out, so an unknown id is refused like a forbidden one.
- Flag a permission `grantsSensitive` when it exposes sensitive data.

**Tests:** `permission-lists.test.ts` (the registry holds every declared list, no key twice), `permissions.test.ts` (`syncPermissions`, including `PermissionSyncError`, and `hasProjectPermission` through project membership), `project-permission-reach.test.ts` (organisation roles in projects), `reach-concurrency.test.ts` (an all-projects grant racing the sensitive flag on two real connections; PostgreSQL only, skipped on PGlite), `organisation-permission.test.ts`, `scoped-permission.test.ts` and `access-denied-error.test.ts`. The `reach` constraints and triggers are tested in `src/db/schema.test.ts`, and `src/accounts/organisation-role-reach.test.ts` goes through a real service.
