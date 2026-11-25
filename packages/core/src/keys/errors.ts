/**
 * Why the server refused to load its keys. A fixed list, so the message of each
 * is fixed too and a caller never has to build one from a value.
 */
export const SERVER_KEYS_REFUSALS = [
  'permissions',
  'unreadable',
  'invalid',
  'identity-missing',
  'identity-mismatch',
  'data-keys-missing',
] as const;

/** One value of `SERVER_KEYS_REFUSALS`. */
export type ServerKeysRefusal = (typeof SERVER_KEYS_REFUSALS)[number];

/**
 * What the operator reads when start-up refuses, for each reason. A message names
 * the key directory setting and the backup, and for a file it also names the path
 * (`path` is where the file is, never what is in it). No message holds a key, a
 * key id or any part of a file (CLAUDE.md, Data rules: server keys live only in
 * `OSFPM_KEYS_DIR`, never in logs, errors or events).
 */
function messageFor(reason: ServerKeysRefusal, path: string | undefined) {
  switch (reason) {
    case 'permissions':
      return `The server key file ${path ?? ''} can be read by other users of this machine. Restrict it to its owner (mode 600, and 700 for its directory) and start the server again.`;
    case 'unreadable':
      return `The server key file or directory ${path ?? ''} could not be read or made. Check that the path is right and that the server may read and write there (OSFPM_KEYS_DIR).`;
    case 'invalid':
      return `The server key file ${path ?? ''} is not a valid key of the kind it should be. The server never replaces a key file it cannot read: restore the file from your backup of the key directory (OSFPM_KEYS_DIR).`;
    case 'identity-missing':
      return 'The server identity key is missing from the key directory (OSFPM_KEYS_DIR), but this database already has one. The key directory does not belong to this database. Restore the matching keys from your backup; the server never makes a new identity for an existing database. With no backup, see "Admin command line" in packages/api/README.md: its new-identity command makes a new identity, and the identity the server publishes changes.';
    case 'identity-mismatch':
      return 'The server identity key in the key directory (OSFPM_KEYS_DIR) does not belong to this database. Restore the matching keys from your backup; the server never replaces the identity key it has stored.';
    case 'data-keys-missing':
      return 'The data keys are missing from the key directory (OSFPM_KEYS_DIR), but this database holds secrets encrypted with them. Restore the key directory (its data-keys folder) from your backup. Without those keys the authenticator-app codes of the people who set them up cannot be checked. With no backup, see "Admin command line" in packages/api/README.md: its accept-data-key-loss command makes fresh data keys, and those people set up their authenticator app again.';
  }
}

/**
 * The server cannot load its keys, so it must not start (decision record on
 * server keys, P-03b6). Thrown at start-up only. `reason` says which of the
 * refusals it is; `message` is fixed text for the operator, with the path of a
 * key file when the fault is in one and never anything from inside a file.
 */
export class ServerKeysError extends Error {
  constructor(
    readonly reason: ServerKeysRefusal,
    /** Where the file or directory is. Never what is in it. */
    readonly path?: string,
  ) {
    super(messageFor(reason, path));
    this.name = 'ServerKeysError';
  }
}

/**
 * A sealed value could not be opened: it is not in the sealed form, it was made
 * with a key this server does not hold, it was changed, or it was made for
 * other additional data. It says nothing more, because a message that told these
 * apart would tell an attacker how far a forgery got, and the message never
 * holds the value or a key id. Callers treat it as "no valid secret".
 */
export class DecryptionError extends Error {
  constructor() {
    super('The sealed value could not be opened');
    this.name = 'DecryptionError';
  }
}
