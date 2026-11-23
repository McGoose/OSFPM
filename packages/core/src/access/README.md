# access

Permission checks and the error a denied call throws. They run on the server only, never on a client.

**Entry points**

- `hasProjectPermission`, `hasOrganisationPermission` and `hasScopedPermission` return true or false for a user, a scope and a permission key.
- `AccessDeniedError` is thrown by a service for a denied call. The layer above maps it to a 403.
- `PERMISSION_LISTS` (`permission-lists.ts`) is the one registry of every permission list a module declares. A module that adds a `*_PERMISSIONS` list adds it there; `permission-lists.test.ts` scans the core and fails when one is missing.
- `permissionAccess(key)` (`permission-access.ts`) says whether a permission is `read` or `write`, from the `access` its definition declares. A key no list declares is `write`, so it fails closed. See "Read and write" below.
- `AccessCredential` (`credential.ts`) is the shape of what a request came in with: a session, or a personal API token with its organisation, project, access and sensitive scope. `SESSION_CREDENTIAL` is the first. `authenticateApiToken` (`src/auth/`) answers the second. `credentialPermits` is the narrowing of a token (see "A personal API token's checks" below), which the three checks above apply when they are given the credential as their last argument.
- `userReachesProject(tx, userId, organisationId, projectId)` (`project-reach.ts`) says whether a person can reach a project at all (a membership of it, or a grant for every project), whatever permission they hold there. Making a token for a project asks it.
- `readApiTokenSwitches(tx, organisationId)` (`api-token-switches.ts`) answers the two organisation switches for personal API tokens, `api.personal-tokens` and `api.personal-tokens.sensitive`, both off until the organisation's settings say `true`. The sensitive switch only counts while tokens are on.
- `syncPermissions` and `PermissionDefinition` fill the `permission` catalogue from the keys a module declares. The API server calls it for every list in `PERMISSION_LISTS` when it starts (`packages/api/src/startup.ts`). It throws `PermissionSyncError` when a key is flagged sensitive while organisation roles hold `all-projects` grants of it (see below).
- `test-fixtures.ts` seeds organisations, users and grants for tests, using invented people from _The Last Withdrawal_.
- First-run setup makes the Administrator role (`createAdministratorRole`, `src/auth/administrator-role.ts`): every permission in `PERMISSION_LISTS`, a sensitive one in its own scope and every other to all projects, so the administrator is the one organisation role that reaches every project for ordinary data and still needs membership for sensitive data. The server tops it up with the permissions a later release declares each time it starts (`topUpAdministratorRoles`).
- `managed-role.ts` is what makes that role managed: `ManagedRoleError`, the guards `assertRoleEditable` and `assertGrantEditable`, and `withManagedRoleMaintenance`, the one way the server writes to a managed role (see below).

**Read and write** (maintainer decision of 23 Nov, task P-03b5)

Every `PermissionDefinition` says `access: 'read' | 'write'`, and the type requires it, so a permission cannot be added without a class. `read` only looks at data; `write` also creates, changes, deletes or hands out access. A personal API token that can only read is refused every permission that is not `read`, which is why the class exists (SC-10, decision D-68). A permission that does both is `write`, so it fails closed: `contracts:read-value` shows contract amounts and also sets them, so a read token cannot hold it until it is split into a read and a write permission, when contracts get routes.

The class lives in code only. It is not a column of the `permission` table, `syncPermissions` does not store it and no response serves it (`permission-access.test.ts` pins that). `permission-lists.test.ts` fails for an entry with no class, and for a key that ends in `:read` and is classed `write` without an `accessReason` in its definition, so a new read permission is not misclassed by accident.

**A personal API token's checks** (SC-10, decisions D-17 and D-68)

A token acts as its owner, narrowed, and never beyond. `hasOrganisationPermission`, `hasProjectPermission` and `hasScopedPermission` take a `credential` as a last argument; without one, or with a session's, they are not narrowed. With a token's, each first asks `credentialPermits`, and only then asks what the owner holds, so a token can only ever pass less than its owner. It refuses when:

1. the scope is another organisation than the token's;
2. the token is for one project and the scope is another project, or the organisation (a project token passes project checks for its project and no check at organisation level);
3. the token is `read` and the permission is classed `write` (`permissionAccess`, which answers `write` for a key no list declares);
4. the permission is sensitive (flagged `grants_sensitive`, and a key the catalogue does not know counts as one) and its key is not in the token's sensitive scope, or the organisation's sensitive switch is off at this moment. The owner holding the permission is then the ordinary check.

A service that a token can reach must be given the credential by its caller and pass it to every check it makes: `MemberActor` and `SensitiveContext` carry it, and the API's `tokenAccess` routes hand it over (`requireCaller`). A service that does not takes no token, and the route that calls it must not say `tokenAccess`. Nothing here is fail-open for a token that is not passed: the plugin refuses a token on every route that does not say it can take one.

**Organisation roles in projects**

Each grant on a role (`role_permission.reach`) says where it applies. The organisation chooses this per permission:

- `own-scope` (the default) applies where the role lives. A project role's grant applies on its project, and an organisation role's grant at organisation level only.
- `all-projects` is only for organisation roles. The grant applies at organisation level and also in every live project of the organisation, with no project membership needed.

`hasOrganisationPermission` counts both reaches. `hasProjectPermission` counts a project membership as before, and also an `all-projects` grant held through an active, undeleted organisation membership, a live link and a live organisation role. A soft-deleted project is not reached.

The database enforces the limits, all with SQLSTATE `23514` and the name in the message:

- `role_permission_all_projects_no_department_check`: an `all-projects` grant has no department.
- `role_permission_all_projects_org_role_only`: an `all-projects` grant needs an organisation role. A role that has such a grant, deleted ones included, cannot become a project role.
- `role_permission_all_projects_not_sensitive`: an `all-projects` grant needs a permission that is not `grants_sensitive`. A permission with such a grant cannot be flagged sensitive, so `syncPermissions` throws `PermissionSyncError` if a module flags one while grants of it exist. The error names the permission key and the organisation roles (organisation id and role key) and nothing from the list is written. The release that flags the permission must ship a migration that narrows those grants to `own-scope`; until it does, an operator narrows or removes them and restarts. A soft-deleted grant still counts: change its reach to `own-scope` or delete the row. The grants of a managed role are not in the message: the server narrows them itself before the sync (`narrowManagedSensitiveGrants`, `src/auth/administrator-role.ts`).

**Managed roles** (`role.managed`, migration `0031_role_managed.sql`)

A managed role is one the server makes and keeps: the Administrator role. An organisation cannot edit or delete it, or give, change or take away its permissions, because a role that the people it governs can edit could be emptied or deleted, and the organisation would have no one left who can do anything.

- **The service guard.** A service that edits or deletes a role calls `assertRoleEditable(tx, roleId)` first, and one that changes or removes a grant calls `assertGrantEditable(tx, grantId)`; to give a role a new grant, it checks the role. Both throw `ManagedRoleError` (the API answers a 409 `role-managed`) and pass for a role or grant that is not there. They read without a lock: a role's flag never changes, and a lock taken before the write helper takes the organisation's change counter would reverse the lock order.
- **The database trigger** refuses the write when a caller skipped the guard, with SQLSTATE `23514` and the constraint name: `role_managed_system_only` (a managed role made by anyone but the server), `role_managed_no_change` (any change to a managed role, a rename or a soft delete included, a delete, and making a role managed or ordinary) and `role_permission_managed_no_change` (a grant added to, changed on, moved on or off, or deleted from a managed role). The messages carry no ids or values.
- **The server's own writes** run inside `withManagedRoleMaintenance(tx, work)`, which sets a transaction-local setting the triggers read, runs `work` with the handle it is given, and puts the setting back, so the rest of the transaction is checked again. Only `createAdministratorRole`, `topUpAdministratorRoles` and `narrowManagedSensitiveGrants` use it. A request must never reach it.

**Rules you must not break**

- A managed role and its grants change only inside `withManagedRoleMaintenance`. A new service that edits roles calls the guards.
- A project role grants nothing in the organisation. An organisation role grants nothing on a project unless the grant has `reach = 'all-projects'`.
- A permission flagged `grantsSensitive` never reaches all projects. Sensitive access always needs project membership. `hasProjectPermission` ignores an `all-projects` grant of such a permission even if one got into the database. This is the privacy rule: sensitive data goes only to those who need it.
- `org_membership.org_role` (owner, admin and so on) grants nothing by itself. Only a role linked to the membership does.
- Only `active` memberships and undeleted rows count. Invited, removed and other organisations' members hold nothing.
- Pass a scope to `AccessDeniedError` only when the caller named it, as a create or a list does. A call by id leaves it out, so an unknown id is refused like a forbidden one.
- Flag a permission `grantsSensitive` when it exposes sensitive data.

**Tests:** `permission-lists.test.ts` (the registry holds every declared list, no key twice, every permission classed read or write), `permission-access.test.ts` (the class of a key, and that the catalogue stores none), `api-token-switches.test.ts` (both switches off by default, the sensitive one counting only while tokens are on), `credential.test.ts` (what a personal API token narrows: organisation, project, read and write, and the sensitive scope with its switch and its owner's access at that moment), `permissions.test.ts` (`syncPermissions`, including `PermissionSyncError`, and `hasProjectPermission` through project membership), `project-permission-reach.test.ts` (organisation roles in projects), `reach-concurrency.test.ts` (an all-projects grant racing the sensitive flag on two real connections; PostgreSQL only, skipped on PGlite), `managed-role.test.ts` (the triggers, the guards and the maintenance switch), `organisation-permission.test.ts`, `scoped-permission.test.ts` and `access-denied-error.test.ts`. The `reach` constraints and triggers are tested in `src/db/schema.test.ts`, and `src/accounts/organisation-role-reach.test.ts` goes through a real service.
