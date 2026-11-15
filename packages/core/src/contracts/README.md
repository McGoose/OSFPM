# contracts

The contracts registry: contracts, their parties and the records they concern. It stores no files, signatures or reminders.

**Entry points:** `createContract`, `updateContract`, `getContract`, `listContracts`, `addContractParty`, `removeContractParty`, `addContractLink` and `removeContractLink`. Permissions are `contracts:read`, `contracts:edit` and `contracts:read-value` (`CONTRACT_PERMISSIONS`).

```ts
// A deal memo for The Last Withdrawal, with no amount, so only `contracts:edit` is needed.
const view = await createContract(tx, ctx, {
  organisationId,
  projectId,
  kind: 'deal-memo',
  title: 'Deal memo: camera operator',
  status: 'draft',
});
```

**Rules you must not break**

- `total_value` and `currency` reach only holders of `contracts:read-value`. For everyone else the keys are absent from every result, including a create or update, never `null` or `0`. Setting either needs that permission too.
- `total_value` is tagged sensitive, so change events never hold it.
- A contract with a project is checked on that project, and one without in the organisation. Roles of one scope grant nothing in the other.
- A call by id denies an unknown, deleted or other organisation's contract exactly like a forbidden one, and names no scope. Create and list do name it.
- Contracts are not sensitive personal data, so a denial writes no audit event.
- A party or link target must be live and in the contract's organisation. Parties and links are soft-deleted, and adding one again restores it.

**Tests:** `service.test.ts`, `tables.test.ts` and `change-events.test.ts`.
