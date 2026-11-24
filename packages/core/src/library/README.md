# library

The organisation's shared record of people, companies and locations. They belong to the organisation and not to a project, and their tables are in `db/schema/`. This folder holds their permissions and, so far, the location services, which structure a location's access and say how far to trust it.

**Entry points**

- `LIBRARY_PERMISSIONS` (`permissions.ts`): the six permissions of the library, in the registry `PERMISSION_LISTS`.
- `getLocation`, `updateLocationAccess` and `verifyLocationAccess` (`locations.ts`).
- `locationAccessSummary` and `locationAccessChangesSchema` (`location-access.ts`).

**Permissions** (spec card SC-08; maintainer decision, P-02l2). All six are held in the organisation, none is flagged sensitive, and the start-up top-up gives them to the Administrator role.

| Key                                 | Class        | What it is for                                                                                                               |
| ----------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `people:read` / `people:edit`       | read / write | Read the people; change them, and, for a person with no account, read and set their delivery preferences (`../preferences/`) |
| `companies:read` / `companies:edit` | read / write | Read the companies; change them                                                                                              |
| `locations:read` / `locations:edit` | read / write | Read a location with its access summary (`getLocation`); change it, set the access answers and verify them                   |

Today the location services and the staff calls on a person's preferences are the only code that checks them: there is no service yet that reads or changes a person or a company. A permission never reaches crew personal data, which stays behind `sensitive:*`.

**A location's access** (decision D-69, P-02l2). A location holds five answers that are `yes`, `no` or `unknown` (`step_free_route`, `accessible_toilet`, `accessible_parking`, `quiet_room`, `seating`), and the details that only make sense under a yes: the distance to the toilet (0 to 5000 metres), and the surface (paved, gravel, grass or other) and the height clearance (100 to 500 centimetres) of the parking. `unknown` is the answer of a location nobody has described, and is not `no`. The database holds the rules (a detail exists only under its yes, the numbers have a range), whatever the service does. `access_notes` stays as free text beside them. They are structured so that a later call-sheet or schedule check can match them with the adjustments people have granted.

- **Verifying is its own act.** `verifyLocationAccess` sets `access_verified_at` and `access_verified_by` to now and the caller (the owner, for a token), in one write. Verifying again moves the date.
- **A change clears the verification, in the same write.** The verification covered the answers as they were, so `updateLocationAccess` clears it with any change to an answer or a detail, and the change log names the clearing with the change. A call that changes nothing writes nothing and keeps it.
- **Details follow their answer.** An answer that stops being yes takes its details with it. A detail named for an answer that is not yes is refused (`LibraryInputError`, 422 `invalid-input`).
- **An unverified answer is never presented as known.** `locationAccessSummary(location)` answers, for each field, `{ stored, effective, verified }`: `effective` is `stored` when the location is verified and `unknown` otherwise (`null` for a detail), so an unverified "yes" is never presented as "yes". It also says when and by whom (`verifiedAt`, `verifiedBy`). `getLocation` adds it to its answer and leaves the raw access columns out of the row, so no reader takes an unverified answer from a plain field.
- **The verifier verifies what they saw.** Both writes take an optional `expectedVersion`. A caller that read the location passes the version they read, and an answer that changed since makes the call fail with `VersionConflictError` and verify nothing.

**Rules you must not break**

- Write a location only through these services and the write helper; never set the access columns elsewhere, and never set the verification without clearing it when an answer changes.
- A call on a location that does not exist, is deleted or is in another organisation fails like any other denial, with no scope, so ids cannot be probed. Locations are not sensitive data, so a denial writes no audit event.
- A read of a location that reaches a person (a call sheet, a schedule check) uses `effective`, never `stored`.
- There are no location routes yet.

**Tests:** `location-access.test.ts` (the summary and the schema of a change, with no database), `location-checks.test.ts` (the CHECKs and the foreign key, straight at the table), `locations.test.ts` (the services: change events, clearing the verification, permissions, tokens, versions), and `../db/delivery-and-access-migrations.test.ts` (what migration 0038 does to existing locations). `test-support.ts` builds their scene.
