# sensitive

Crew personal data: dietary, medical, accessibility, emergency, identity, financial, representation and compliance. `service.ts` is the only code that reads or writes the `person_sensitive` table.

**Entry points**

- `readSensitive`, `writeSensitive` and `deleteSensitive` work on one category of one person.
- `complianceReport` returns counts per department, with no names, ids or payloads.
- `payloadSchemas` and `SENSITIVE_CATEGORIES` (`schemas.ts`); `SENSITIVE_PERMISSIONS` (`permissions.ts`).
- `SensitiveChangeNotifier` queues a notice when staff change a person's data. The default queues nothing.

**Rules you must not break**

- Nothing else may name `person_sensitive`. `source-scan.test.ts` fails if other code does.
- Access is the person themselves, or a holder of `sensitive:read:<category>` or `sensitive:edit:<category>` on a project where the person is `confirmed` or `released`. Owners and admins get nothing automatically.
- Audit every allowed read and every denial, with the category and never a value. A denial throws after its audit event is written, so catch it inside the transaction and commit.
- Never log, email or put a payload value in an error, an audit detail, a change event or a notifier call.
- A notifier only enqueues, through the transaction it is handed, and never sends. The write and its notice share one savepoint, so they succeed or fail together.
- An unknown or deleted person is denied like any other, so ids cannot be probed.
- A new category needs a payload schema, a retention class in `service.ts` and a migration for the table's CHECK.

**Tests:** `service.test.ts`, `schemas.test.ts`, `table.test.ts`, `compliance-report.test.ts` and `source-scan.test.ts`. `payload-fixtures.ts` holds invented payloads for people in _The Last Withdrawal_.
