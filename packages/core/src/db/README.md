# db

The database layer: clients, the Drizzle schema, the write helper and the column conventions every table follows.

**Entry points**

- `createDatabase` and `migrate`: PostgreSQL or PGlite, one migration set (`client.ts`, `migrate.ts`).
- `insertRecord`, `updateRecord`, `softDeleteRecord`, `restoreRecord` and `recordAudit` (`write.ts`).
- `tenantTable` and `standardColumns` (`columns.ts`); one file per table in `schema/`.

**Rules you must not break**

- Tenant records are written only through `write.ts`, with the transaction handle. It numbers the change, logs one `change_event` and keeps sensitive values out of it. An update that changes no field checks the version, then writes nothing.
- Define tenant tables with `tenantTable()`. Plain `pgTable` is for install-level, log and counter tables.
- A tenant table with no `project_id` calls `registerProjectResolver` or `declareOrganisationLevel` next to its definition. A schema test requires one of the two.
- Tag sensitive columns with `markSensitive`. Never put a sensitive value in a log, an error or an audit detail.
- IDs come from `newId()` (UUIDv7). The database never makes them.
- Migrations are forward-only. Put a comment above each hand-written SQL block, such as the append-only triggers, and say so in the commit message.
- Name foreign keys `<table>_<target>_fk`. A key that starts with `organisation_id` keeps the reference inside one organisation.

**Tests:** `schema.test.ts` checks every table's structure and constraints. `change-log.test.ts` and `write-project.test.ts` cover the write helper. `production-structure.test.ts`, `library.test.ts` and `retention-class.test.ts` cover their tables. `test-support.ts` provides the PGlite and PostgreSQL targets.
