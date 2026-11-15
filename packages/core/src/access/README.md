# access

Permission checks and the error a denied call throws. They run on the server only, never on a client.

**Entry points**

- `hasProjectPermission`, `hasOrganisationPermission` and `hasScopedPermission` return true or false for a user, a scope and a permission key.
- `AccessDeniedError` is thrown by a service for a denied call. The layer above maps it to a 403.
- `syncPermissions` and `PermissionDefinition` fill the `permission` catalogue from the keys a module declares. Nothing calls it at start-up yet.
- `test-fixtures.ts` seeds organisations, users and grants for tests, using invented people from _The Last Withdrawal_.

**Rules you must not break**

- Scopes never overlap. A project role grants nothing in the organisation, and an organisation role grants nothing on a project.
- `org_membership.org_role` (owner, admin and so on) grants nothing by itself. Only a role linked to the membership does.
- Only `active` memberships and undeleted rows count. Invited, removed and other organisations' members hold nothing.
- Pass a scope to `AccessDeniedError` only when the caller named it, as a create or a list does. A call by id leaves it out, so an unknown id is refused like a forbidden one.
- Flag a permission `grantsSensitive` when it exposes sensitive data.

**Tests:** `permissions.test.ts` (`syncPermissions` and `hasProjectPermission`), `organisation-permission.test.ts`, `scoped-permission.test.ts` and `access-denied-error.test.ts`.
