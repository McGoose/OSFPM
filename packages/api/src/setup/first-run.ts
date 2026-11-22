import { ensureInstallation } from '@osfpm/core/src/auth/ensure-installation.js';
import { AuthStateError } from '@osfpm/core/src/auth/errors.js';
import {
  isSetupComplete,
  issueSetupCode,
  SETUP_CODE_LIFETIME_MS,
} from '@osfpm/core/src/auth/setup-code.js';
import type { App } from '../app.js';

/**
 * What the server does about first-run setup (SC-10, decision D-56) each time it
 * starts: make sure the `installation` row exists and, until the first
 * administrator has been created, issue a setup code to print. The code is the
 * only secret OSFPM ever prints, and it goes to standard error, outside the
 * JSON logger (see `runStartup`). The logger must keep masking codes; nothing
 * here asks it to let one through.
 */

/**
 * Makes sure the `installation` row exists and, if first-run setup is not
 * complete, issues a new setup code, which revokes the earlier live one, and
 * answers the raw code. Answers null once setup is complete: no code is issued.
 * The raw code is not stored anywhere (only its hash is), so the caller prints
 * it and drops it.
 *
 * The row and the code are made in one transaction, which holds the installation
 * row lock from the first write to the commit, so servers that start together
 * take turns; the last to issue is the one whose code works. The caller prints
 * only after this has returned, so a printed code is always one that was saved.
 *
 * Only server start-up calls this, before any request is served, so it checks no
 * permission.
 *
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export async function issueFirstRunCode(app: App): Promise<string | null> {
  const now = new Date();
  return app.db.db.transaction(async (tx) => {
    await ensureInstallation(tx, { baseUrl: app.publicOrigin, now });
    if (await isSetupComplete(tx)) return null;
    try {
      return await issueSetupCode(tx, now);
    } catch (error) {
      // Another server finished setup between the check and the issue, and
      // `issueSetupCode` refuses once it has: there is nothing to print.
      if (
        error instanceof AuthStateError &&
        error.reason === 'setup-complete'
      ) {
        return null;
      }
      throw error;
    }
  });
}

/**
 * The text the server prints for a setup code, a clearly marked block of five
 * lines ending in a newline: the code, where to enter it, and how long it works.
 * The hours come from `SETUP_CODE_LIFETIME_MS`, so the text cannot disagree with
 * the code's real lifetime. `publicUrl` is the address people open.
 *
 * This is the one place a raw secret is turned into text for a person. It goes
 * to standard error and nowhere else: never to the logger, a response or the
 * audit trail (CLAUDE.md, Data rules).
 */
export function setupCodeBlock(code: string, publicUrl: string): string {
  const hours = SETUP_CODE_LIFETIME_MS / (60 * 60 * 1000);
  return (
    [
      '=== OSFPM first-run setup ===',
      `Setup code: ${code}`,
      `Open ${publicUrl} and enter this code within ${hours} hours.`,
      'A new code is printed on every restart until setup is complete.',
      '=============================',
    ].join('\n') + '\n'
  );
}
