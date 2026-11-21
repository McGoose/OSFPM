import { installation } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';

/**
 * There is no `installation` row yet, so this server has no id. It is only
 * possible before first-run setup has created the row. The message carries no
 * id and no value.
 */
export class InstallationMissingError extends Error {
  constructor() {
    super('There is no installation yet');
    this.name = 'InstallationMissingError';
  }
}

/**
 * The id of this server: the `id` of the single `installation` row. Rows and
 * contexts that name the server doing something carry it, as `origin_server` on
 * a record and as `originServer` on a `WriteContext`. It never changes once the
 * row exists, so a caller may keep it.
 *
 * A read, and the one way to get the id: other code does not select from
 * `installation` itself. It checks no permission: the id is an identifier every
 * record carries (CLAUDE.md, Data rules), and a caller needs no more than the
 * transaction handle.
 *
 * `lock` holds the row until the transaction ends, so that a concurrent call that
 * also locks it waits. Only the services that serialise on the installation (the
 * setup code) pass it; everyone else leaves it out.
 *
 * @throws InstallationMissingError when there is no `installation` row.
 */
export async function getServerId(
  tx: Tx,
  options: { readonly lock?: boolean } = {},
): Promise<string> {
  const query = tx.select({ id: installation.id }).from(installation).limit(1);
  const [row] = await (options.lock ? query.for('update') : query);
  if (!row) throw new InstallationMissingError();
  return row.id;
}
