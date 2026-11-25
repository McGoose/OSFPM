# admin

The admin command line (decision D-64: system administration in this phase is a command line, and shell access to the server is the trust boundary, because no installation-level web role exists yet). Run it from the repository root:

```sh
pnpm --filter @osfpm/api admin <command> [options]
```

It reads the same environment as the server (`DATABASE_URL` or `OSFPM_DATA_DIR`, `OSFPM_KEYS_DIR`, `OSFPM_PUBLIC_URL`, and the rest, through the server's own `loadConfig`, with the same fixed messages). A real `osfpm` binary comes with the production image (P-07); this folder is the development form. The full description, with the commands and a recovery walkthrough, is under "Admin command line" in [packages/api/README.md](../../README.md).

**This folder only parses arguments, takes the in-use marker and prints.** What the commands read and change is in the core: `packages/core/src/auth/admin-report.ts` (the facts, and the audit event of a command that changed nothing), `auth/emergency-access.ts` and `auth/admin-sessions.ts` (the links and the sessions), `retention/transient-cleanups.ts` (the cleanups), `db/status.ts` (migrations and the database clock) and `db/in-use.ts` (the marker), and the key files are read and made only by `packages/core/src/keys/server-keys.ts`.

**Entry points**

- `main.ts`: the program. It hands the process's arguments, environment and output to `runAdmin` and exits with its code.
- `run.ts`: `runAdmin(argv, context)`, the whole command line as a function, and the exit codes (`EXIT`: 0 done, 1 refused or failed, 2 usage error). Every command passes the same guards, in order: the settings load, the database is marked as in use for the kind of command, it answers, and no migration is pending. The command line never migrates.
- `args.ts`: `parseAdminArguments` (`node:util`'s `parseArgs`, strict) and `USAGE`. The request is a union by command; an option that names a person or a number may not be given twice, an id must be shaped like one, and `--hours` takes the bounds of a reset link's lifetime.
- `session.ts`: `openAdminSession` (opens the database and takes the marker; never makes a PGlite database), `requireMigrated`, `AdminContext` (the process: environment, output, clock, and for tests a database that is open) and `describeFailure` (what a failure prints: fixed text, or the class name and short code of an error, never a driver's message).
- `info.ts` and `doctor.ts`: the two commands that only read. `info` prints counts, ids and fingerprints; `doctor` prints `ok`, `warn`, `fail` or `skipped` for each check. Both take `--json`, and each writes one `admin.command-run` audit event.
- `key-commands.ts`: `rotate-data-key`, `accept-data-key-loss` and `new-identity`, the commands that change the server's keys (`new-identity` does nothing without `--confirm-new-identity`, and refuses when an identity file exists). They need every server stopped (the exclusive in-use marker is taken before they run), call `rotateDataKey`, `acceptDataKeyLoss` and `replaceServerIdentity` of the core in one transaction, which takes the `installation` row first and writes the audit event, and print counts and fixed words.
- `key-state.ts`: what the key directory says, as states (`checkIdentityFile`, `readDataKeyState`).
- `emergency-access.ts`, `revoke-sessions.ts` and `run-cleanups.ts`: the three commands that only write rows a running server writes too (P-09a2, decision D-81), so on PostgreSQL they run beside servers (they take the `read-only-command` in-use role, which takes no lock there). `emergency-access` asks the core's `issueEmergencyAccess` for a reset link made as the system, and prints it on standard error, once, in a marked block (`emergencyAccessBlock`) built with `accessResetLink` from `../access-reset/link.ts`, which the route for a member's link uses too; standard output says only for which user id a link was printed and when it ends. `revoke-sessions` calls `revokeSessionsOfPerson` once for each person, each in its own transaction, and prints user ids and counts. `run-cleanups` runs every entry of `TRANSIENT_CLEANUPS` with one clock, each in its own transaction, prints one count for each table, and exits 1 after the others ran when one failed.

**Rules you must not break**

- Nothing printed, logged or audited holds a key, a key id, a secret, a token, an email address or a database URL. Only counts, the installation's id, fingerprints, booleans, paths of key files and dates (CLAUDE.md, Data rules). **The one exception is the emergency access link**, which `emergency-access` prints on standard error and nowhere else: not on standard output, not through a logger, not in an audit event, a row or an error, and only after the transaction that made it has committed. A failure prints the error's class name and its short code and nothing else; the exceptions are the errors written for the operator (`AdminRefusal`, `DatabaseInUseError`, `ServerKeysError`, `ConfigError`), whose text is fixed.
- A message never repeats what the operator typed (an address, an id, a number): usage errors and refusals are fixed sentences.
- Standard output is the report; standard error is everything else (errors, warnings, refusals, the usage after a mistake) and the one link.
- With PGlite the server must be stopped for every command, read-only ones too: two processes never open one data directory.
- `revoke-sessions` writes more than one audit event (the sessions' own, one for each person, and one `admin.command-run` with the totals). A command that changes a person takes the person's user row `FOR UPDATE` first, in the core, and never holds two.

**Tests:** `pnpm test packages/api/src/admin` (PGlite always, and PostgreSQL too when `DATABASE_URL` is set). `test-support.ts` has the helpers: `runCommand` runs the command line in-process over a test database, and `partialMigrations` makes a database with migrations pending.
