import {
  acceptDataKeyLoss,
  rotateDataKey,
} from '@osfpm/core/src/auth/server-key-admin.js';
import type { Config } from '../config.js';
import {
  AdminRefusal,
  type AdminContext,
  type AdminSession,
} from './session.js';

/**
 * The commands that change the server's keys: `rotate-data-key` and
 * `accept-data-key-loss`. They need every server stopped, which the admin command
 * line has made sure of before it gets here (the in-use marker, taken exclusively).
 * This file only calls the core service, in one transaction that holds the
 * `installation` row, and prints what happened: counts and fixed words, never a
 * key, a key id or a secret (CLAUDE.md, Data rules). Each command writes one audit
 * event, in the same transaction.
 */

/** What an operator is told when the database has no installation yet. */
const NO_INSTALLATION =
  'There is no installation on this database yet. Start the server once, which makes it, stop it, and run the command again.';

/** `1 authenticator secret`, `2 authenticator secrets`. */
function secrets(count: number): string {
  return `${count} authenticator secret${count === 1 ? '' : 's'}`;
}

/**
 * Runs `rotate-data-key`: a new data key becomes the current one, and every
 * authenticator secret that an older key sealed and a key in the directory still
 * opens is re-sealed under it. Prints the two counts and reminds the operator that
 * the old key files must be kept. Exit code 0.
 *
 * @throws AdminRefusal when the database has no installation yet.
 * @throws ServerKeysError for a key file that cannot be used; nothing was written.
 */
export async function runRotateDataKey(
  config: Config,
  session: AdminSession,
  context: AdminContext,
): Promise<number> {
  const now = (context.now ?? (() => new Date()))();
  const result = await session.database.db.transaction((tx) =>
    rotateDataKey(tx, { keysDir: config.keysDir, now }),
  );
  if (!result.ok) throw new AdminRefusal(NO_INSTALLATION);
  const lines = [
    'Added a new data key and made it the current one.',
    `Re-sealed ${secrets(result.resealed)} with it.`,
  ];
  if (result.unopenable > 0) {
    lines.push(
      `${secrets(result.unopenable)} cannot be opened with any key in the key directory and ${result.unopenable === 1 ? 'was' : 'were'} left as ${result.unopenable === 1 ? 'it is' : 'they are'}.`,
    );
  }
  lines.push(
    'The old key files were kept. Keep them: an older backup of the database still needs them.',
  );
  context.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * Runs `accept-data-key-loss`: for an install whose data keys are gone, it makes a
 * fresh data key and makes it current, touching no row, and says how many
 * authenticator secrets can no longer be opened. When the directory has a usable
 * current key already it changes nothing and says so. Exit code 0 in both cases.
 *
 * @throws AdminRefusal when the database has no installation yet.
 * @throws ServerKeysError for a data key file or a `current` that cannot be used.
 */
export async function runAcceptDataKeyLoss(
  config: Config,
  session: AdminSession,
  context: AdminContext,
): Promise<number> {
  const now = (context.now ?? (() => new Date()))();
  const result = await session.database.db.transaction((tx) =>
    acceptDataKeyLoss(tx, { keysDir: config.keysDir, now }),
  );
  if (!result.ok) throw new AdminRefusal(NO_INSTALLATION);
  if (!result.accepted) {
    context.stdout.write(
      [
        'Nothing to accept: the key directory has a usable current data key, and nothing was changed.',
        `${secrets(result.unopenable)} cannot be opened with the keys it holds.`,
      ].join('\n') + '\n',
    );
    return 0;
  }
  context.stdout.write(
    [
      'Made a fresh data key and made it the current one. No row was changed.',
      result.unopenable === 0
        ? 'No authenticator secret is affected.'
        : `${secrets(result.unopenable)} cannot be opened and ${result.unopenable === 1 ? 'stays' : 'stay'} as ${result.unopenable === 1 ? 'it is' : 'they are'}: the people who set them up sign in with a passkey, a recovery code or a reset link, and set up their authenticator app again.`,
      'The server can be started now.',
    ].join('\n') + '\n',
  );
  return 0;
}
