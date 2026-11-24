# contracts

The contracts registry: contracts, their parties, the records they concern and, for person-facing deals, the agreed deal terms. It stores no files, signatures or reminders, and it calculates nothing.

**Entry points:** `createContract`, `updateContract`, `getContract`, `listContracts`, `listOwnContracts`, `addContractParty`, `removeContractParty`, `addContractLink`, `removeContractLink`, `setContractTerms`, `removeContractTerms` and `isContractParty`. Permissions are `contracts:read`, `contracts:edit` and `contracts:read-value` (`CONTRACT_PERMISSIONS`).

```ts
// A deal memo for The Last Withdrawal, with no amount, so only `contracts:edit` is needed.
const view = await createContract(tx, ctx, {
  organisationId,
  projectId,
  kind: 'deal-memo',
  title: 'Deal memo: camera operator',
  status: 'draft',
});

// Its terms: a day rate for ten guaranteed hours. The rate is an amount, so this also needs `contracts:read-value`.
await setContractTerms(tx, ctx, view.id, {
  currency: 'GBP',
  rate: '450.50',
  rateBasis: 'daily',
  guaranteedHours: '10',
  overtimeRuleKey: 'uk-film-overtime',
  paymentTermsDays: 30,
});
```

**Rules you must not break**

- `total_value` and `currency` reach only holders of `contracts:read-value` and the contract's parties. For everyone else the keys are absent from every result, including a create or update, never `null` or `0`. Setting either needs that permission too.
- `total_value` is tagged sensitive, so change events never hold it.
- A contract with a project is checked on that project, and one without in the organisation. A role of one scope grants nothing in the other, except that an organisation role's grant with `reach = 'all-projects'` also applies on every project of the organisation. `contracts:read-value` is sensitive, so it never reaches all projects: seeing a project contract's amounts needs project membership (see `src/access/README.md`).
- A call by id denies an unknown, deleted or other organisation's contract exactly like a forbidden one, and names no scope. Create and list do name it.
- Contracts are not sensitive personal data, so a denial, and a party's read, write no audit event.
- A party or link target must be live and in the contract's organisation. Parties and links are soft-deleted, and adding one again restores it.

**A party always sees their own contract** (decision D-73, Q6). `isContractParty` (`party.ts`) is the one definition, and `getContract` and `listOwnContracts` both use it. A user is a party when a live `contract_party` row names a live `person` whose `user_id` is theirs, or when it names a company and a live `person_company` link makes them its `owner` or `director`, valid today in UTC (`start_date` empty or not after today, `end_date` empty or not before it). That covers the loan-out company that crew often work through. An `employee` of the company, a person it is `represented-by` and an `other` link do not count, and neither does a link that has ended or not yet begun. A party reads the contract, its parties and links, `total_value`, `currency` and the terms with every amount, whatever contracts permissions they hold, and `listOwnContracts(tx, ctx, organisationId)` returns all of theirs, across projects, oldest first, with full views, and `[]` for a caller who is a party to nothing. Someone who is neither a reader nor a party gets the same denial as for an unknown id. **Being a party never grants a write**: editing still needs `contracts:edit`, and an amount still needs `contracts:read-value` as well. `listContracts`, `createContract` and `updateContract` are unchanged: they follow `contracts:read-value` alone, even for a contract the caller is a party to.

**Deal terms** (`contract_terms`, `terms.ts`) hold what was agreed, so a later dispute about money has something structured to be checked against. A contract has at most one set of terms, and only a deal memo, a crew contract or a cast contract can have them (`ContractInputError` otherwise).

- Fields: `currency`; `rate` with `rateBasis` (`hourly`, `daily`, `weekly`, `flat`, `buyout`); `guaranteedHours` per basis period, none for `flat` and `buyout`; `overtimeRuleKey`; `kitFee` with `kitFeeBasis` and `kitInventory`; `perDiem`; `mileageRate` with `mileageUnit`; `paymentTermsDays`; `pensionApplies`. An amount needs a currency, a rate its basis, a kit fee its basis, a mileage rate its unit. The service checks every field and these rules before it writes, so a mistake is a `ContractInputError` and the CHECKs of the table are only the backstop.
- **No legal or agreement numbers are stored.** `overtimeRuleKey` only names a rule; the multipliers and thresholds are rule-pack data (CLAUDE.md, Data rules). `mileageRate` is the one rate in the table, a rate per unit the parties agreed, which is contract data and not a legal default.
- The four amounts (`rate`, `kitFee`, `perDiem`, `mileageRate`) are sensitive: change events name them without their values, and they are absent for a caller who may not see them, like `total_value`. The other terms, the currency among them, are visible to anyone who can read the contract. An amount is a decimal string of at most 15 digits before the point and 4 after, not below zero (`db/decimal.ts`, shared with cost lines); `guaranteedHours` has 2 places and is at most 168.
- `setContractTerms` needs `contracts:edit`, and `contracts:read-value` as well when it names any amount, even to clear it. It is a patch: a key that is left out stays, `null` clears. It creates the row, changes it, or restores a removed one, and a restored row holds exactly what was given, with nothing from before. `expectedVersion` is the version the caller read; without it the call acts on what it reads at its start. A write that finds the terms changed since is refused: `VersionConflictError` for an update, `ContractTermsConflictError` for a first-time set that lost the race to another (409), never a database error.
- `removeContractTerms` is a soft delete and needs the permissions of a change that clears every amount: `contracts:edit` and `contracts:read-value`.
- Both take the contract's change counter and then hold the contract row `FOR SHARE` (CLAUDE.md, Data rules: lock order), so the contract's kind cannot change under the check. A contract whose kind is changed afterwards, to one that has no terms, keeps the terms it has.
- A refusal for a rule between fields can show that a field the caller may not see is set: clearing a currency while a hidden rate stays is refused as an amount without a currency.

**Tests:** `service.test.ts`, `tables.test.ts` and `change-events.test.ts` for contracts, parties and links; `party.test.ts` for the party rule; `terms.test.ts` for the terms service, `terms-table.test.ts` for the CHECKs of `contract_terms`, and `terms-race.test.ts` for concurrent writes (PostgreSQL only, skipped on PGlite).
