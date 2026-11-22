import { InviteRefusedError } from '@osfpm/core/src/auth/invite-errors.js';
import type { Tx } from '@osfpm/core/src/db/write.js';
import type { App } from '../app.js';

/**
 * Runs `work` in one transaction and answers what it answers, with one rule for a
 * refusal of an invite step (`InviteRefusedError`, which every refusal extends): the
 * transaction is committed first and the error is thrown after. The invite services
 * audit a refusal (an inspect that failed, an accept that was refused) and then
 * throw, and the audit event is in the caller's transaction, so a transaction that
 * rolled back with the error would take the event with it (CLAUDE.md, Data rules:
 * where a denial is audited, the caller catches the error inside the transaction and
 * commits). Any other error rolls the transaction back as usual. The route that
 * calls it answers the thrown error through the error table, so a client gets the
 * one answer for each kind of refusal.
 *
 * Checks no permission and writes nothing itself.
 *
 * @throws The `InviteRefusedError` `work` threw, after the commit; anything else
 * `work` throws, unchanged, after the rollback.
 */
export async function withRefusalsCommitted<T>(
  app: App,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  const outcome = await app.db.db.transaction(async (tx) => {
    try {
      return { ok: true, value: await work(tx) } as const;
    } catch (error) {
      if (error instanceof InviteRefusedError) {
        return { ok: false, error } as const;
      }
      throw error;
    }
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
