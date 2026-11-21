# costs

Cost lines and their incentive-scheme tags. A cost line is one amount of money on a project, booked to an account of the project's chart. It is the shared row that budgets, purchase orders, invoices, expenses and timesheets will write to (a later phase). A scheme tag says whether a line qualifies for an incentive or funding scheme, such as a tax rebate. There is no HTTP API, no budget or invoice, no totals or reports, and no scheme rules: the rules come from rule packs later, and a tag only records a decision.

**Entry points:** `createCostLine`, `updateCostLine`, `removeCostLine`, `getCostLine`, `listCostLines`, `setCostLineScheme` and `removeCostLineScheme`. Permissions are `costs:read`, `costs:edit` and `costs:tag-schemes` (`COST_PERMISSIONS`). The tables are `cost_line` and `cost_line_scheme`.

```ts
// A camera hire invoice for The Last Withdrawal, paid in US dollars.
const line = await createCostLine(tx, ctx, {
  organisationId,
  projectId,
  stage: 'actual',
  sourceType: 'invoice',
  sourceId: invoiceId,
  accountId, // a postable account of the project's chart
  description: 'Camera hire, week 1',
  territory: 'GB',
  productionPhase: 'principal-photography',
  amount: '1250.50',
  currency: 'USD',
  fxRate: '0.7900000000', // the project is in GBP: amountProjectCurrency is 987.8950
});

// Tag it for a scheme, with the part that qualifies.
await setCostLineScheme(tx, ctx, line.id, 'uk-hetv', {
  status: 'qualifying',
  qualifyingAmount: '500.00',
  reason: 'Shot and hired in the UK',
});
```

**Rules you must not break**

- Money is never a `number`. Amounts and rates are decimal strings, an amount has at most four places and a rate ten, and more is refused, not rounded. The project-currency amount is computed by the database in `numeric` (`round(amount * fx_rate, 4)`, halves away from zero), never in JavaScript.
- A line in the project's currency takes no `fx_rate` and its project amount equals its amount. A line in another currency needs one. The service enforces this because a CHECK cannot read the project's currency. Changing the amount, the rate or the currency computes the project amount again in the same write. A trigger on `project` refuses to change the project's currency while it has live cost lines (SQLSTATE 23514, `project_currency_locked`), so no line is left priced in a currency the project no longer has; the service reads the project `FOR SHARE` when it prices a line, so a line being written at the same moment makes the change wait.
- Amounts, and the qualifying amount of a tag, are visible only with `costs:read`, which is flagged as granting sensitive data. The results of create, update, removal and tagging leave the keys out for everyone else, never `null` or `0`. Setting a qualifying amount needs `costs:read` as well, because it is checked against the line's own amount and a refusal would reveal it.
- Amounts never reach `change_event`: they are marked with `markSensitive`, so only the field names appear in `changed_fields`. `currency` and `fx_rate` stay in the event.
- An account takes cost lines only when it is live, postable and in a live chart of the line's own project. A payee, unit or episode must be live in the organisation, and a unit or episode in the project too; the composite foreign keys refuse the rest. A line has at most one payee, and the payee's residency is never copied onto it: reports will read it through the sensitive-data service.
- The accounts service refuses to remove an account, or a chart with such an account, while a live cost line is booked to it (`AccountInUseError`). Cost lines read their account with a share lock and the removal takes an update lock first, so the two cannot cross.
- A line has at most one live tag per scheme key. `setCostLineScheme` creates the tag or replaces the live one, so what it leaves out ends up empty, and it records the acting user and the time. The qualifying amount needs the `qualifying` status, the sign of the line's project amount (or zero) and no larger a size, compared by the database.
- All three permissions are checked on the line's project. A call by id denies an unknown, removed or other organisation's line exactly like a forbidden one, and names no scope. Create and list name the project. A denial writes no audit event: cost lines are not sensitive personal data in the sense of `person_sensitive`.
- Removing a line removes its live tags in the same savepoint. A removed tag frees its key, so tagging again makes a new tag.
- Both tables use the `financial-record` retention class and default to private visibility. `cost_line_scheme` has no `project_id`: it finds its project through its cost line.

**Tests:** `tables.test.ts` (every constraint, with SQLSTATE and constraint names), `service.test.ts` and `change-events.test.ts`. `test-fixtures.ts` seeds charts, accounts and rows for them.
