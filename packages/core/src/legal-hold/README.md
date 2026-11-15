# legal-hold

Legal holds: while a hold is unreleased, the records it covers must not be purged or erased. This module places, releases and checks holds. It purges and erases nothing, and nothing calls `isUnderLegalHold` yet.

**Entry points**

- `placeLegalHold` covers the whole organisation, one project, or one record (`entityType` with `entityId`).
- `releaseLegalHold` ends a hold and keeps it as history.
- `isUnderLegalHold` says whether any unreleased hold covers an organisation, project or record. Purge and erase code must call it first.
- `LEGAL_HOLD_PERMISSIONS` and `LEGAL_HOLD_MANAGE_PERMISSION` (`legal-hold:manage`).

**Rules you must not break**

- Place and release need `legal-hold:manage` in the hold's own scope: on the project for a hold with one, in the organisation otherwise.
- Holds are released, never deleted. The table refuses a soft delete.
- Audit a denial before throwing it. Place and release each write one audit event in the same savepoint as the hold row.
- Release by id denies an unknown hold exactly like a forbidden one and names no scope, so ids cannot be probed.
- A reason is free text. Audit events never copy it, and callers must not put sensitive values in it.
- A record hold does not cover its project. A project hold covers what is in the project, so pass `projectId` along with the record.

```ts
const hold = await placeLegalHold(tx, ctx, {
  organisationId,
  projectId, // The Last Withdrawal
  reason: 'Open dispute over a location agreement',
});
await releaseLegalHold(tx, ctx, hold.id, 'Dispute settled');
```

**Tests:** `service.test.ts`.
