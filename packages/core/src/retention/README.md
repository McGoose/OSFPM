# retention

The shipped retention periods, the calculation of when a record may be purged, and the list of cleanups for working rows. The date calculation deletes nothing, and neither does the list: only the cleanup functions it names delete, and they are for the worker.

**Entry points**

- `retentionEndDate` returns the end date as `YYYY-MM-DD`, or `null` for "no automatic purge".
- `SHIPPED_RETENTION_DEFAULTS` and `RETENTION_CLASS_KEYS` (`defaults.ts`). The class keys are seeded by migrations.
- `TRANSIENT_CLEANUPS` (`transient-cleanups.ts`) maps each `transient` table to its cleanup. The worker calls each one on a schedule, with a transaction handle and the time.

```ts
// Wrap date of The Last Withdrawal. The period is for illustration only,
// and `noDates` stands for all five dates set to null.
retentionEndDate({
  anchor: 'project-wrap',
  periodsYears: [1],
  dates: { ...noDates, wrapDate: '2028-02-29' },
}); // '2029-02-28'
```

**The `transient` class**

For working rows that cleanup removes once they are of no use. `session`, `login_challenge` and `setup_code` use it. The audit log is the record of what happened, so the row itself is not kept. The class counts from `record-created` and has no period, so `retentionEndDate` returns `null` for it: retention never purges these rows, cleanup does.

Each table has its cleanup, and `TRANSIENT_CLEANUPS` lists them. A cleanup takes the transaction handle and `now`, deletes in one statement, returns how many rows it deleted, and writes no audit event: it is housekeeping, and the events were written when the rows changed.

- `session`: `cleanupEndedSessions` deletes a session that was revoked, or went idle, more than `SESSION_DEFAULTS.endedKeepMs` before `now`.
- `login_challenge`: `cleanupExpiredChallenges` deletes every challenge that has expired.
- `setup_code`: `cleanupSetupCodes` deletes every code that was used, revoked or has expired.

**Rules you must not break**

- Legal and financial periods live only in `SHIPPED_RETENTION_DEFAULTS`, each marked `verified: false`, until the rule-pack engine replaces them. Never repeat a shipped period anywhere else.
- Never give `transient` a period, and never use it for a row that is the only record of something: cleanup deletes the row and the audit log is the record (maintainer decision, P-03b3a).
- A table whose default class is `transient` has an entry in `TRANSIENT_CLEANUPS`. `transient-cleanups.test.ts` finds those tables from the schema, so it fails when one has no cleanup, and when an entry names a table that is not transient. A new transient table adds its cleanup to the list in the same change.
- A missing anchor date, a `null` period or no periods at all means no automatic purge. The longest period wins.
- An unknown anchor is an error, not "no date". Returning `null` would keep a record forever without anyone being told.
- Years are added to the calendar date. 29 February plus whole years is 28 February in a non-leap year.

**Tests:** `retention.test.ts`, `transient-cleanups.test.ts` (every transient table has a cleanup, and running the whole list clears each table), and `../db/retention-class.test.ts` for the `retention_class` table and for what the `transient` migrations do to sessions, login challenges and setup codes that already exist. Each cleanup is tested with its service, in `../auth/`.
