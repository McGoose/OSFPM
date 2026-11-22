import { installation } from './installation.js';
import { user } from './user.js';

/**
 * Install-level tables, apart from `SECURITY_TABLES`, that only named core
 * services write. They have no `organisation_id`, so the write helper cannot
 * write them and no change event is made for them (CLAUDE.md, Data rules); the
 * named service audits each change instead. `services` are the folders of
 * `packages/core/src/` that may write the table, so `'auth'` is `src/auth/`.
 * First-run setup lives there too (`createUser`, `ensureInstallation` and
 * `completeFirstRunSetup`), so it needed no new service. Adding a writer is a
 * change here, in the same commit as the code. A test scans the source and fails
 * when any other file writes one of these tables.
 */
export const SERVICE_WRITTEN_TABLES = [
  { table: user, services: ['auth'] },
  { table: installation, services: ['auth'] },
] as const;
