# members

The people who belong to an organisation: who may list them and who may invite more (spec card SC-10, decision D-57). Invites themselves are made, inspected and accepted by the auth services (`src/auth/`), because the `invite` tables are security tables that only `src/auth/` writes.

**Entry points**

- `listMembers(tx, { userId }, organisationId)` (`service.ts`) lists the organisation's undeleted memberships with user id, display name, address, tier, status and the keys of the live organisation roles. It needs `members:read`; a stranger, a member without it and an organisation that does not exist get the same `AccessDeniedError` with no scope. It reads `org_membership`, `org_membership_role` and `role` and, for a name and an address only, `user`.
- `MEMBER_PERMISSIONS` (`permissions.ts`), the catalogue rows of the two organisation-level permissions: `members:read` (list the members) and `members:invite` (create, list and revoke invites). Neither is sensitive. The list is in `PERMISSION_LISTS`, so the server syncs it at start-up and the Administrator role is topped up with both.

**Rules you must not break**

- A tier (`org_membership.org_role`) grants nothing by itself: what a member may do comes from their roles (decision D-51). Nothing here treats `owner` or `admin` as a permission.
- No member listing returns anything about how a person signs in, and none returns crew personal data (CLAUDE.md, Privacy rule).

**Tests:** `members.test.ts` (only this organisation's members, six fields and no sign-in detail, the same refusal for a stranger, a member without the permission and an organisation that does not exist), `src/access/permission-lists.test.ts` checks that the list is in the registry, and `src/auth/administrator-members.test.ts` that the start-up top-up gives the Administrator role both permissions.
