# projects

Creating a project. A project never exists without its main unit, so every way of creating one goes through `createProject`.

**Entry point:** `createProject(tx, ctx, values)` creates the project and its main unit, both through the write helper, and returns `{ project, mainUnit }`. `MAIN_UNIT` holds the unit's key and name.

```ts
const { project, mainUnit } = await createProject(tx, ctx, {
  organisationId,
  ownerOrgId: organisationId,
  code: 'TLW',
  title: 'The Last Withdrawal',
  format: 'feature',
  status: 'development',
  timezone: 'Europe/London',
  locale: 'en-GB',
  currency: 'GBP',
});
```

**Rules you must not break**

- Production code must not insert a project with `insertRecord` directly. It would have no main unit.
- The two writes run in one savepoint. If the unit fails, the project, its counter row and its events are rolled back too, even when the caller catches the error and commits.
- `createProject` checks no permission. The caller must have done that first.
- Whether a project may have episodes is not decided here.

**Tests:** `createProject` is covered in `../db/write-project.test.ts` and `../db/production-structure.test.ts`.
