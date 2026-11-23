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

For working rows that cleanup removes once they are of no use. `session`, `login_challenge`, `setup_code`, `invite`, `access_reset` and `api_token` use it. The audit log is the record of what happened, so the row itself is not kept. The class counts from `record-created` and has no period, so `retentionEndDate` returns `null` for it: retention never purges these rows, cleanup does.

Each table has its cleanup, and `TRANSIENT_CLEANUPS` lists them. A cleanup takes the transaction handle and `now`, deletes in one statement, returns how many rows it deleted, and writes no audit event: it is housekeeping, and the events were written when the rows changed.

- `session`: `cleanupEndedSessions` deletes a session that was revoked, or went idle, more than `SESSION_DEFAULTS.endedKeepMs` before `now`.
- `login_challenge`: `cleanupExpiredChallenges` deletes every challenge that has expired.
- `setup_code`: `cleanupSetupCodes` deletes every code that was used, revoked or has expired.
- `invite`: `cleanupInvites` deletes every invite that was used, revoked or has expired, with the same cut-off as setup codes. Its role links (`invite_role`) go with it by `ON DELETE CASCADE`: that table has no retention class and no entry of its own.
- `access_reset`: `cleanupAccessResets` deletes every admin reset link that was used, revoked or has expired, with the same cut-off as invites.
- `api_token`: `cleanupApiTokens` deletes every personal API token that was revoked or has expired, with the same cut-off as reset links. A token that never expires (`expires_at` NULL) is live until it is revoked, so it is never deleted for being old.

**The `account-lifetime` class**

For a row that belongs to an account and not to a production: `user_access_profile` uses it (decision D-69). **A row of this class never ends by time.** It is kept while the account exists and ends in two ways only: the person deletes it, or the account is deleted, which erases it (`endAccountAccessSharing` in `src/sensitive/`; the account-deletion service that will call it does not exist yet). The class counts from `record-created`, the one anchor that names no project, and has no period, so `retentionEndDate` returns `null` for it whatever the date: no wrap, delivery or exploitation date and no purge by class reaches these rows, and no cleanup lists them. The anchor is only a label here, because with no period no date is ever worked out from it. The grants a profile opens (`access_grant`) are not in this class: they stay `crew-health`, the class of the data a production sees.

**The `security-log` class**

Reserved for audit rows that hold IP addresses, as its description in `0013_seed_retention_classes` says. No table uses it yet.

**Rules you must not break**

- Legal and financial periods live only in `SHIPPED_RETENTION_DEFAULTS`, each marked `verified: false`, until the rule-pack engine replaces them. Never repeat a shipped period anywhere else.
- Never give `transient` a period, and never use it for a row that is the only record of something: cleanup deletes the row and the audit log is the record (maintainer decision, P-03b3a).
- Never give `account-lifetime` a period, and never use it for a row that belongs to a project: a project's wrap must not reach a row that outlives projects (decision D-69, P-02l1).
- A table whose default class is `transient` has an entry in `TRANSIENT_CLEANUPS`. `transient-cleanups.test.ts` finds those tables from the schema, so it fails when one has no cleanup, and when an entry names a table that is not transient. A new transient table adds its cleanup to the list in the same change.
- A missing anchor date, a `null` period or no periods at all means no automatic purge. The longest period wins.
- An unknown anchor is an error, not "no date". Returning `null` would keep a record forever without anyone being told.
- Years are added to the calendar date. 29 February plus whole years is 28 February in a non-leap year.

**Tests:** `retention.test.ts`, `transient-cleanups.test.ts` (every transient table has a cleanup, and running the whole list clears each table), `account-lifetime.test.ts` (the class has no period and no end date for any anchor, is in no cleanup list and has no project, for every table that uses it, found from the schema), `../db/retention-class.test.ts` for the `retention_class` table and for what the `transient` and `account-lifetime` migrations do to rows that already exist, `../sensitive/profile-retention.test.ts` (a project's wrap and every cleanup leave an access profile as it was) and `../sensitive/profile-erasure-paths.test.ts` (a profile is deleted in one place, which only the person's deletion and the account's end of sharing call). Each cleanup is tested with its service, in `../auth/`.
