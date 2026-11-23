import { declareServiceWrittenTable } from '../columns.js';
import { installation } from './installation.js';
import { userAccessProfile } from './user-access-profile.js';
import { userPreferences } from './user-preferences.js';
import { user } from './user.js';

/**
 * Install-level tables, apart from `SECURITY_TABLES`, that only one named core
 * service writes. They have no `organisation_id`, so the write helper cannot write
 * them and no change event is made for them (CLAUDE.md, Data rules); the named
 * service audits each change instead.
 *
 * Each is declared with `declareServiceWrittenTable`, which records its writer in
 * the registry `tableWriters` (`db/columns.ts`), the one record of who writes it:
 * the folder of `packages/core/src/`, the auth service unless the declaration names
 * another and says why in one line. `write-helper-scan.test.ts` reads that registry,
 * and fails when any other folder writes the table and when the declared folder does
 * not exist. First-run setup lives in `src/auth/` too (`createUser`,
 * `ensureInstallation` and `completeFirstRunSetup`), so it needed no other service.
 * Adding a table here, or changing a writer, is a change in the same commit as the
 * code.
 *
 * `user_access_profile` and `user_preferences` are the two whose writer is not the auth
 * service: the sensitive service writes the first and the preferences service the second,
 * each with the reason in its declaration.
 */
export const SERVICE_WRITTEN_TABLES = [
  declareServiceWrittenTable(user, { service: 'auth' }),
  declareServiceWrittenTable(installation, { service: 'auth' }),
  declareServiceWrittenTable(userAccessProfile, {
    service: 'sensitive',
    reason:
      'A person’s own access needs are sensitive data, so the sensitive service is the only door to them, as it is for person_sensitive (decision D-69).',
  }),
  declareServiceWrittenTable(userPreferences, {
    service: 'preferences',
    reason:
      'A person’s delivery preferences can hint at something they have not shared, so one service writes them and system code reads them through it (decision D-69, P-02l2).',
  }),
] as const;
