# db

The database layer: clients, the Drizzle schema, the write helper and the column conventions every table follows.

**Entry points**

- `createDatabase` and `migrate`: PostgreSQL or PGlite, one migration set (`client.ts`, `migrate.ts`). On PostgreSQL `migrate` holds an advisory lock for its whole run (`MIGRATION_LOCK_KEY`), so servers that start together take turns, and runs the migration on that same connection, so a pool of one is enough; PGlite takes no lock.
- `insertRecord`, `updateRecord`, `softDeleteRecord`, `restoreRecord` and `recordAudit` (`write.ts`). `lockProjectChanges` and `lockOrganisationChanges` (also `write.ts`) take a project's change counter and an organisation's own, for a service that must lock a record before it writes: queue on the counter first, as the helper does, then take the record lock, or it can deadlock with a helper write. Use the first for a record of a project and the second for a record of the organisation alone (a membership, a role); they are two functions, not one with a null, so a call cannot change meaning by accident. They share one internal lock and number nothing. The one exception is a new project or a new organisation: its counter references the row, so `insertRecord` takes it after the row, and gives it seq 1 in its own sequence. Nothing else can write to a record that is not committed yet, so no writer can be waiting on that counter.
- `tenantTable`, `securityTable` and `standardColumns` (`columns.ts`); one file per table in `schema/`.

**Rules you must not break**

- Tenant records are written only through `write.ts`, with the transaction handle. It numbers the change, logs one `change_event` and keeps sensitive values out of it. An update that changes no field checks the version, then writes nothing.
- Define tenant tables with `tenantTable()` and login tables with `securityTable()`, and list each security table in `SECURITY_TABLES`. Plain `pgTable` is for the other install-level, log and counter tables.
- Security tables (sessions, credentials, one-time codes) are written only by `src/auth/`, directly, and audited instead of change-logged. `write-helper-scan.test.ts` fails when a tenant table is written outside `write.ts` or a security table outside `src/auth/`.
- `user` and `installation` are written only by the services named in `SERVICE_WRITTEN_TABLES` (`schema/service-written-tables.ts`), never through `write.ts`, and audited instead of change-logged. The same scan enforces it. Adding a writer is a change to that list in the same commit. First-run setup is in `src/auth/`, which the list already names.
- A tenant table with no `project_id` calls `registerProjectResolver` or `declareOrganisationLevel` next to its definition. A schema test requires one of the two.
- Tag sensitive columns with `markSensitive`. Never put a sensitive value in a log, an error or an audit detail.
- IDs come from `newId()` (UUIDv7). The database never makes them.
- Migrations are forward-only. Put a comment above each hand-written SQL block, such as the append-only triggers, and say so in the commit message.
- Migrations may change metadata of existing rows (retention class, defaults) without audit events; they never change security state (revoke, disable, grant).
- Name foreign keys `<table>_<target>_fk`. A key that starts with `organisation_id` keeps the reference inside one organisation.

**Tests:** `schema.test.ts` checks every table's structure and constraints. `change-log.test.ts`, `write-project.test.ts` and `write-organisation.test.ts` cover the write helper: the last two cover a new project and a new organisation, the tables whose counter comes after the row, and `write-organisation.test.ts` also pins that order and, on PostgreSQL only, creates organisations at the same time. `lock-changes.test.ts` covers `lockOrganisationChanges` (it numbers nothing; on PostgreSQL only, that it queues behind and in front of an organisation-level write, and that it never waits on a project's counter or another organisation's). `production-structure.test.ts`, `library.test.ts` and `retention-class.test.ts` cover their tables. `migrate-lock.test.ts` checks, with the migrator replaced, the order of what `migrate` does around it and that it runs on the one connection that holds the lock. `migrate.test.ts`, on PostgreSQL only, runs the real migrator: two migrators at once, one that waits for a held lock, a pool of one connection, and a failed migration. `test-support.ts` provides the PGlite and PostgreSQL targets.
