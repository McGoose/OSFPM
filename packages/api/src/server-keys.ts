import { bindServerKeys } from '@osfpm/core/src/auth/server-key-binding.js';
import type { ServerKeys } from '@osfpm/core/src/keys/server-keys.js';
import type { App } from './app.js';

/**
 * Where the app holds the server's keys once start-up has loaded them. The keys
 * are loaded after the database is reached (what the database says decides what
 * a missing file means, see `bindServerKeys`), and the app is built before that,
 * so routes read them through this store at request time. A request is only
 * answered once start-up has finished, which is after the keys are set, so
 * `get` throwing is a bug in the server, never something a caller can cause.
 */
export type ServerKeyStore = {
  /**
   * The loaded keys. Routes and services take what they need from them: the
   * public identity key to publish, the data-key ring for the services that
   * seal a secret. Nothing here is logged or returned whole.
   *
   * @throws Error when start-up has not set the keys yet.
   */
  readonly get: () => ServerKeys;
  /** Sets the keys. Only start-up calls it, and tests through `buildApp`. */
  readonly set: (keys: ServerKeys) => void;
};

/**
 * A store, empty or holding `initial`. The error `get` throws before the keys are
 * set says nothing about them.
 */
export function createServerKeyStore(initial?: ServerKeys): ServerKeyStore {
  let keys = initial;
  return {
    get: () => {
      if (keys === undefined) {
        throw new Error('The server keys are not loaded yet');
      }
      return keys;
    },
    set: (loaded) => {
      keys = loaded;
    },
  };
}

/**
 * The start-up step that loads the server's keys from `keysDir`, binds the
 * identity key to the installation and puts the keys in the app's store (the
 * core's `bindServerKeys`; read it for the rules, the refusals and the lock). One
 * transaction, which holds the `installation` row lock from the first read to the
 * commit, so servers that start together take turns. The keys are set in the store
 * only after the commit, so a failed step leaves the app without them.
 *
 * Only server start-up calls this, before any request is served, so it checks no
 * permission. It answers whether this start stored the identity key for the first
 * time and how many authenticator secrets it sealed, for log lines; nothing about
 * a key or a secret leaves it.
 *
 * @throws Error when start-up was not given a key directory.
 * @throws ServerKeysError when the key directory is not this database's or a key
 * file cannot be used; the message is for the operator and names a path at most.
 * @throws AuthStateError `installation-missing` before the installation row exists.
 * @throws RecordWriteError when the database refuses a write.
 */
export async function bindServerKeysAtStartup(
  app: App,
  keysDir: string | undefined,
): Promise<{
  readonly identityBound: boolean;
  readonly secretsSealed: number;
}> {
  if (keysDir === undefined) {
    throw new Error('Start-up was not given a key directory');
  }
  const bound = await app.db.db.transaction((tx) =>
    bindServerKeys(tx, { keysDir, now: new Date() }),
  );
  app.serverKeys.set(bound.keys);
  return {
    identityBound: bound.identityBound,
    secretsSealed: bound.secretsSealed,
  };
}
