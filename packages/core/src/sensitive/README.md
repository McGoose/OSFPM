# sensitive

Crew personal data: dietary, medical, accessibility, emergency, identity, financial, representation and compliance. This folder is the one door to it. `service.ts` is the only code that reads or writes the `person_sensitive` table, and the other files here are the only code that reads or writes `user_access_profile` and `access_grant`, the two tables of the access needs model.

**Entry points**

- `readSensitive`, `writeSensitive` and `deleteSensitive` (`service.ts`) work on one category of one person.
- Access needs (decision D-69, below): `createAccessProfile`, `readAccessProfile`, `updateAccessProfile` and `deleteAccessProfile` (`access-profile.ts`); `createAccessGrant`, `revokeAccessGrant` and `shareWithSuggestedRoles` (`access-grants.ts`); `listGrantedAdjustments` (`adjustments.ts`).
- `complianceReport` returns counts per department, with no names, ids or payloads.
- `payloadSchemas`, `SENSITIVE_CATEGORIES`, `ACCESS_FIELDS`, `ACCESS_GROUPS` and `MEDICAL_FIELDS` (`schemas.ts`); `SENSITIVE_PERMISSIONS` (`permissions.ts`); `ACCESS_SUGGESTED_ROLES_SETTING` and `readSuggestedRoles` (`suggested-roles.ts`).
- `SensitiveChangeNotifier` queues a notice when staff change a person's data. The default queues nothing.

**Access needs: three layers** (decision D-69)

Most disabled and neurodivergent crew never disclose, so access needs are recorded as practical adjustments, owned by the person and shared only with people who need them. Nothing asks for a condition or a diagnosis. This follows the TV Access Project's Access Passport and Channel 4's Access Rider; `ACCESSIBILITY.md` at the root says it in words for the public.

1. **The person's profile** (`user_access_profile`). One per account, in the structured shape of the `accessibility` payload: a schedule (earliest and latest times, longest day, breaks, notice), physical needs, transport, communication, environment, support, and free-text notes. Only the person creates, reads, changes or deletes it: not an organisation owner, not an administrator, not a personal API token. It has no organisation and no project, so it stays when a production wraps and goes only when the person deletes it or their account goes. Retention class `crew-health`: its anchor is the project wrap, and a profile has no project, so no end date applies.
2. **The production's record** (`person_sensitive`). For a person without an account, staff who hold `sensitive:edit:accessibility` enter the same structured adjustments, and the retention class deletes it after wrap. For a person with an account, writing their `accessibility` row is refused (`UseAccessProfileError`, 422 `use-access-profile`): their adjustments live in their profile. Medical data stays here for everyone, as the organisation's record.
3. **Grants** (`access_grant`). A production sees nothing of a person's adjustments or medical data until the person grants it, field by field, to a role, on one project. Default deny.

**Grants**

- **Who makes one.** The person themselves, when they have an account. For a person without one, a user who holds `sensitive:edit:<category>` on the project, who records how and when the person agreed (`method`, `at`, and an optional `note` of up to 200 characters with no health details). Staff cannot grant for a person with an account.
- **Who revokes one.** The person, or staff who edit, for a grant that was recorded on someone's behalf. A role has one live grant: making another for it replaces it, in one step. A revoke opens nothing from the moment it commits.
- **What it names.** A role, which must be a live role of the organisation that is an organisation template or belongs to this project (one answer, `RoleNotAvailableError`, 422 `role-not-available`, for a missing, deleted or foreign one), and fields: keys of the category's payload, each once (`ACCESS_FIELDS`, or `conditions`, `medication` and `notes` for `medical`).
- **When it is live.** It is not revoked, the project is not deleted, delivered or archived and is not past its `wrap_date` (by the date in the project's own time zone, and live through the wrap date itself), and the person still has a proposed or confirmed `project_person` row on the project. This is worked out when it is read (`grant-reads.ts`, `liveness.ts`), never stored, so no job is needed: a project that wraps, a person who is released and a grant revoked a moment ago stop opening anything at once, and the grant row never changes.
- **Share with the usual roles.** `shareWithSuggestedRoles` makes one grant for each role the organisation usually shares each group with (the setting `access.suggested-roles`, a map from a group, and `medical`, to role ids; empty by default and read only until the settings service of P-04 writes it), covering the fields the person has filled in those groups. `notes` is never included, in either category: free text goes only by an explicit grant. With `preview: true` it writes nothing and says who would see what, which is what a confirmed call then makes.
- **The constraint view.** `listGrantedAdjustments` gives, for each person on a project, only the adjustments they granted to a role the reader holds there and have filled in. It is what a schedule or call sheet check can plan around: no reasons, no medical data, no field that was not granted.

**Who reads what**

| Reader                                                          | `accessibility`                                                                                                              | `medical`        |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| The person themselves                                           | All of it: their profile, or the production record if they have no account                                                   | All of it        |
| Holds `sensitive:read:<category>` on the project                | Only the fields that live grants to a role they hold in an active membership of that project cover; with none it is a denial | The same         |
| Holds `sensitive:edit:<category>`, for a person with no account | The whole production record, which they need to edit it                                                                      | The whole record |
| A personal API token                                            | What its owner reads through the token's sensitive scope; grants still apply; never the person's own way in                  | The same         |
| Anyone else, an owner or an administrator included              | Denied                                                                                                                       | Denied           |

`dietary` and `emergency` keep the rules of P-02e: the read permission on a project where the person is engaged is enough, and no grant is needed.

**Rules you must not break**

- Nothing else may name `person_sensitive`, `user_access_profile` or `access_grant` (the last two are the tables the registry `tableWriters` says this service writes). `source-scan.test.ts` fails if other code does.
- For the categories other than the two of the access needs model, access is the person themselves, or a holder of `sensitive:read:<category>` or `sensitive:edit:<category>` on a project where the person is `confirmed` or `released`. Owners and admins get nothing automatically.
- `accessibility` and `medical` are read only through live, person-approved grants: the sensitive-read permission alone is never enough (see the table).
- A personal API token (`SensitiveContext.credential`) reaches the same data only through its explicit sensitive scope: it must list the permission's key, the organisation's sensitive switch must be on, and the token's owner must hold the permission on a shared project at that moment (`hasProjectPermission` narrows by the credential). A token never takes the person's own way in, so it cannot read, change or grant for its owner's own data. Its writes are the token's in the change log (actor `token`, made for its owner), and every read and every denial through a token is audited with the token's id (actor `token`, details `tokenId` and `userId`).
- Audit every allowed read and every denial, with the category and never a value. A read of `accessibility` or `medical` also carries the number of fields it returned, and never their names: a field name alone can hint at a condition. A denial or a refusal throws after its audit event is written, so catch it inside the transaction and commit.
- A grant, a revoke and the shortcut are audited as `access.grant-created`, `access.grant-revoked` and `access.shortcut-used`, a profile change as `access.profile-created`, `-updated` and `-deleted`, and a refusal of a rule as `access.refused` with a reason code from a closed list. They hold ids, counts and codes only. Profiles and grants are service-written: audited, not change-logged.
- Never log, email or put a payload value, a field name of the access needs or a consent note in an error, an audit detail, a change event or a notifier call.
- A notifier only enqueues, through the transaction it is handed, and never sends. The write and its notice share one savepoint, so they succeed or fail together. A staff save that changes nothing writes nothing and queues no notice.
- An unknown or deleted person, project or grant is denied like any other, so ids cannot be probed. A revoke of a grant the caller may not end is the same not found as for one that is not there.
- A new category needs a payload schema, a retention class in `service.ts` and a migration for the table's CHECK.

**Tests:** `service.test.ts`, `schemas.test.ts`, `table.test.ts`, `compliance-report.test.ts`, `token-access.test.ts` (reads and writes through a personal API token: only with the scope, the switch and the owner's access, and every read audited with the token id) and `source-scan.test.ts`. The access needs model has `access-adjustments.test.ts` (the structured schema), `access-profile.test.ts`, `access-grants.test.ts`, `grant-reads.test.ts` (the read rules), `grant-liveness.test.ts` and `liveness.test.ts`, `share-with-suggested-roles.test.ts`, `list-granted-adjustments.test.ts`, `account-holder-writes.test.ts`, `suggested-roles.test.ts` and `access-tables.test.ts`; `access-grant-race.test.ts` runs only on PostgreSQL. `test-support.ts` builds their scene, and `payload-fixtures.ts` holds invented payloads for people in _The Last Withdrawal_.
