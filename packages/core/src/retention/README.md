# retention

The shipped retention periods and the calculation of when a record may be purged. This module only works out dates. It deletes nothing.

**Entry points**

- `retentionEndDate` returns the end date as `YYYY-MM-DD`, or `null` for "no automatic purge".
- `SHIPPED_RETENTION_DEFAULTS` and `RETENTION_CLASS_KEYS` (`defaults.ts`). The class keys are seeded by a migration.

```ts
// Wrap date of The Last Withdrawal. The period is for illustration only,
// and `noDates` stands for all five dates set to null.
retentionEndDate({
  anchor: 'project-wrap',
  periodsYears: [1],
  dates: { ...noDates, wrapDate: '2028-02-29' },
}); // '2029-02-28'
```

**Rules you must not break**

- Legal and financial periods live only in `SHIPPED_RETENTION_DEFAULTS`, each marked `verified: false`, until the rule-pack engine replaces them. Never repeat a shipped period anywhere else.
- A missing anchor date, a `null` period or no periods at all means no automatic purge. The longest period wins.
- An unknown anchor is an error, not "no date". Returning `null` would keep a record forever without anyone being told.
- Years are added to the calendar date. 29 February plus whole years is 28 February in a non-leap year.

**Tests:** `retention.test.ts`, and `../db/retention-class.test.ts` for the `retention_class` table.
