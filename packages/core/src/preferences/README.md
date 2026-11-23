# preferences

How a person wants to receive information (decision D-69, P-02l2): plain-text or HTML email, a standard, easy-read or large-print document, a text size, a channel, each message as it comes or a daily digest, and quiet hours. They are **ordinary settings, not sensitive data**, so nobody has to disclose anything to get an accessible format. They are still shown only to the person, to staff who hold `people:edit` (for a person with no account) and to system code. That is a courtesy and not a legal requirement: a choice such as `easy-read` can hint at something a person has not chosen to share.

**Entry points**

- `preferencesSchema`, `effectivePreferencesSchema`, `parsePreferences`, `withDefaults` and `PREFERENCE_DEFAULTS` (`schemas.ts`): the one strict Zod schema, used for the account's row, the person's column and the body of `PUT /me/preferences`.
- `readOwnPreferences` and `saveOwnPreferences` (`service.ts`): the signed-in person's own, for a person with an account.
- `readPersonPreferences` and `savePersonPreferences`: what staff keep for a person with no account.
- `effectivePreferences(tx, personId)`: what applies to a person. **The one call later modules (the email module, call sheets) make, and nothing else.**
- `eraseUserPreferences`: ends an account's row. `endAccountAccessSharing` (`../sensitive/`) calls it when an account is deleted.

**The fields**

| Field                | Values                                                           | Default                                                             |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `emailFormat`        | `html`, `plain-text`                                             | `html` (every email also has a plain-text part, whatever is chosen) |
| `documentFormat`     | `standard`, `easy-read`, `large-print`                           | `standard`                                                          |
| `textSize`           | `default`, `large`, `extra-large`                                | `default`                                                           |
| `preferredChannel`   | `email`, `sms`, `app`                                            | `email`                                                             |
| `notificationRhythm` | `instant`, `daily-digest`                                        | `instant`                                                           |
| `quietHours`         | `{ start: 'HH:MM', end: 'HH:MM' }` in the person's own time zone | none (`null` when read)                                             |

Every field is optional. Only the choices made are stored, and the defaults are applied when the preferences are read (`withDefaults`, the one place they live). Quiet hours may cross midnight (22:00 to 07:00) and may not start and end at the same time, because a window that starts and ends at one time says nothing. **An urgent message may override the quiet hours and the digest.** That is a decision for the email module (P-03c), made there: nothing here decides what is urgent, and `effectivePreferences` returns the person's choices as they are.

**Where they live**

- **A person with an account:** `user_preferences`, an install-level table with one row per user, in the retention class `account-lifetime`: kept while the account exists, and never ended by time. Only this folder writes it (declared in `tableWriters()`), and every change is audited and not change-logged, because the table has no organisation to number a change in. The event is `preferences.saved` (action `create` the first time, `update` after), with the user and the names of the fields that changed, and never a value.
- **A person with no account:** the nullable column `person.communication_preferences`, written through the write helper like the rest of `person`, so a change is logged as a change of the person. Nothing in it is sensitive.
- **What applies** (`effectivePreferences`): the account's preferences win, whole, when the person has an account and has saved any (saving `{}` counts, so a person can go back to the defaults); otherwise what staff recorded on the person, so a person who gets an account keeps what was recorded until they save their own; otherwise the defaults. Nothing is mixed field by field. The account of a deleted user is ignored, and a stored value that no longer fits the schema (one a later release removed) counts as nothing chosen, so a message is never held up by it.

**Who reads what**

| Reader                                             | A person with an account                                     | A person with no account                                        |
| -------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| The person themselves, signed in                   | Their own, by `GET` and `PUT /me/preferences` (session only) | Has no account to sign in with                                  |
| Staff holding `people:edit` in the organisation    | Refused, with the same answer as no permission               | Read and set (`readPersonPreferences`, `savePersonPreferences`) |
| System code                                        | `effectivePreferences`                                       | `effectivePreferences`                                          |
| Anyone else, an owner or an administrator included | Refused                                                      | Refused                                                         |

A personal API token reaches none of it through the routes. The staff calls take the token's credential and narrow by it (a `people:edit` check, which is a write permission, so a read-only token is refused). A call on a person who does not exist, is deleted or is in another organisation fails like any other denial, so ids cannot be probed. Staff who try to set the preferences of a person with an account get `UseAccountPreferencesError` (422), after the permission check, so someone who may not edit learns nothing about the person.

**Rules you must not break**

- Only this folder names `user_preferences` and `person.communication_preferences`. `source-scan.test.ts` fails when other code does. There is no ordinary read of a person yet; when one is written it lists the columns it wants and never selects the whole row, which would carry the column without naming it.
- A save holds the user row `FOR KEY SHARE` until it commits, so an account deletion (which holds it `FOR UPDATE`) cannot leave a row behind it: the save finishes first, and is erased, or finds the account deleted (CLAUDE.md, Data rules; `save-race.test.ts`, PostgreSQL only).
- Never put a choice in a log, an error or an audit detail. An event names the fields that changed and no value, and an error lists paths and codes only.
- There is no route for another person's preferences. Staff set those of a person with no account through the core service.
- Defaults live in `PREFERENCE_DEFAULTS` and nowhere else.

**Tests:** `schemas.test.ts` (every field and value, quiet hours, the defaults, errors that never echo a value), `service.test.ts` (an account's own, staff, `effectivePreferences`, erasing), `table.test.ts` (the table, its writer, the person column), `source-scan.test.ts` (who may name the two places), and `save-race.test.ts` (PostgreSQL only: a save racing an account deletion, and two first saves at once). `test-support.ts` builds their scene. The routes are tested in `packages/api/src/preferences/`, and the erasing with the account in `../sensitive/account-sharing-end.test.ts`.
