# admin

The admin command line (decision D-64: system administration in this phase is a command line, and shell access to the server is the trust boundary, because no installation-level web role exists yet). Run it from the repository root:

```sh
pnpm --filter @osfpm/api admin <command> [options]
```

It reads the same environment as the server (`DATABASE_URL` or `OSFPM_DATA_DIR`, `OSFPM_KEYS_DIR`, `OSFPM_PUBLIC_URL`, and the rest, through the server's own `loadConfig`, with the same fixed messages). A real `osfpm` binary comes with the production image (P-07); this folder is the development form. The full description, with the commands and a recovery walkthrough, is under "Admin command line" in [packages/api/README.md](../../README.md).

**This folder only parses arguments, takes the in-use marker and prints.** What the commands read and change is in the core: `packages/core/src/auth/admin-report.ts` (the facts, and the audit event of a command that changed nothing), `db/status.ts` (migrations and the database clock) and `db/in-use.ts` (the marker), and the key files are read and made only by `packages/core/src/keys/server-keys.ts`.

**Entry points**

- `main.ts`: the program. It hands the process's arguments, environment and output to `runAdmin` and exits with its code.
- `run.ts`: `runAdmin(argv, context)`, the whole command line as a function, and the exit codes (`EXIT`: 0 done, 1 refused or failed, 2 usage error). Every command passes the same guards, in order: the settings load, the database is marked as in use for the kind of command, it answers, and no migration is pending. The command line never migrates.
- `args.ts`: `parseAdminArguments` (`node:util`'s `parseArgs`, strict) and `USAGE`.
- `session.ts`: `openAdminSession` (opens the database and takes the marker; never makes a PGlite database), `requireMigrated`, `AdminContext` (the process: environment, output, clock, and for tests a database that is open) and `describeFailure` (what a failure prints: fixed text, or the class name and short code of an error, never a driver's message).
- `info.ts` and `doctor.ts`: the two commands that only read. `info` prints counts, ids and fingerprints; `doctor` prints `ok`, `warn`, `fail` or `skipped` for each check. Both take `--json`, and each writes one `admin.command-run` audit event.
- `key-commands.ts`: `rotate-data-key` and `accept-data-key-loss`, the commands that change the data keys. They need every server stopped (the exclusive in-use marker is taken before they run), call `rotateDataKey` and `acceptDataKeyLoss` of the core in one transaction, which takes the `installation` row first and writes the audit event, and print counts and fixed words.
- `key-state.ts`: what the key directory says, as states (`checkIdentityFile`, `readDataKeyState`).

**Rules you must not break**

- Nothing printed, logged or audited holds a key, a key id, a secret, a token, an email address or a database URL. Only counts, the installation's id, fingerprints, booleans, paths of key files and dates (CLAUDE.md, Data rules). A failure prints the error's class name and its short code and nothing else; the exceptions are the errors written for the operator (`AdminRefusal`, `DatabaseInUseError`, `ServerKeysError`, `ConfigError`), whose text is fixed.
- Standard output is the report; standard error is everything else (errors, warnings, refusals, the usage after a mistake).
- With PGlite the server must be stopped for every command, read-only ones too: two processes never open one data directory.

**Tests:** `pnpm test packages/api/src/admin` (PGlite always, and PostgreSQL too when `DATABASE_URL` is set). `test-support.ts` has the helpers: `runCommand` runs the command line in-process over a test database, and `partialMigrations` makes a database with migrations pending.
