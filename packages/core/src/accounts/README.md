# accounts

Charts of accounts. An organisation keeps template charts, and each project copies one and edits its own copy. Cost lines (`src/costs/`) are booked to a project's accounts. There is no HTTP API and no import or export of files yet.

**Entry points:** `createChart`, `updateChart`, `removeChart`, `copyChartToProject`, `addAccount`, `updateAccount`, `removeAccount`, `getChart` and `listCharts`. Permissions are `accounts:read` and `accounts:edit` (`ACCOUNT_PERMISSIONS`). The tables are `account_chart` and `account`.

```ts
// Copy the organisation's template into The Last Withdrawal and make it the project's default.
const chart = await copyChartToProject(tx, ctx, {
  sourceChartId: templateId,
  projectId,
  makeDefault: true,
});
```

**Rules you must not break**

- A chart with no `project_id` is an organisation template, checked in the organisation. A project chart is checked on its project. A role of one scope grants nothing in the other, except that an organisation role's grant with `reach = 'all-projects'` also applies on every project of the organisation (see `src/access/README.md`).
- Copying needs `accounts:read` on the organisation and `accounts:edit` on the project. The copy is atomic: the chart and every live account, or nothing.
- A chart is a copy, not a link: later changes to the template never reach it. `copied_from_chart_id` only records where it came from.
- A parent is always in the same chart. An update that would make an account its own ancestor is refused (`AccountInputError`), and an account with live children cannot be removed (`AccountHasChildrenError`, a `RecordStateError`).
- An account with a live cost line booked to it cannot be removed, and neither can a chart that has such an account (`AccountInUseError`, a `RecordStateError`). The same error refuses making such an account non-postable (`updateAccount` with `isPostable: false`; its `attempted` field says which), while other edits of it are allowed. The check runs before anything is written, queues on the project's change counter and then locks the accounts it looks at, so a cost line being written at the same moment cannot slip through.
- Making a chart the default (`createChart`, `updateChart`, `copyChartToProject`) takes the default from the scope's old one in the same savepoint. A scope is the organisation's templates, or one project.
- `removeChart` removes the chart and all its live accounts in one savepoint, or nothing. The check for live children belongs to `removeAccount` alone, because the whole tree goes. Charts copied from a removed template stay.
- Keys and codes are unique among live records only, so a removed one can be used again as a new record, and `removeChart` sets `is_default` to false in the same write, so a removed chart is never a default and a later restore cannot give its scope a second one.
- A call by id denies an unknown, removed or other organisation's record exactly like a forbidden one, and names no scope. Create and list do name it.
- Charts of accounts are not sensitive personal data, so a denial writes no audit event. Both tables use the `financial-record` retention class.

**Tests:** `tables.test.ts`, `service.test.ts` and `change-events.test.ts`.
