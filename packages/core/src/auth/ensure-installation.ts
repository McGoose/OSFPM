import { installation } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { AUTH_AUDIT, guardedAuth, recordAuthAudit } from './shared.js';

/**
 * Makes sure this server has its single `installation` row, and answers its id
 * and whether this call made it. The id is a new UUIDv7 and is never replaced:
 * a row that exists is left exactly as it is, `base_url` included, so the id
 * every record carries as `origin_server` cannot change (CLAUDE.md, Data
 * rules).
 *
 * Safe when two servers start at the same moment. The insert is
 * `ON CONFLICT DO NOTHING` on the unique index that allows one row, so the
 * second one waits for the first to commit, inserts nothing, and reads the row
 * the first made. Audited as `auth.installation-created`, once, by the call that
 * made the row (CLAUDE.md, Data rules: `installation` changes are audited).
 *
 * Only server start-up calls this, before it serves a request and before any
 * session exists, so it checks no permission. `baseUrl` is where this server was
 * first reached (the origin of `OSFPM_PUBLIC_URL`); the live setting stays in
 * the configuration.
 *
 * @throws RecordWriteError when the database refuses the write; it carries the
 * SQLSTATE and constraint name only.
 */
export function ensureInstallation(
  tx: Tx,
  input: { baseUrl: string; now: Date },
): Promise<{ id: string; created: boolean }> {
  const { baseUrl, now } = input;
  return guardedAuth('installation', 'insert', () =>
    // A savepoint: a failure leaves no row and no event.
    tx.transaction(async (inner) => {
      const [made] = await inner
        .insert(installation)
        .values({ baseUrl, createdAt: now })
        .onConflictDoNothing()
        .returning({ id: installation.id });
      if (made !== undefined) {
        await recordAuthAudit(inner, {
          category: AUTH_AUDIT.installationCreated,
          action: 'create',
          actor: { type: 'system', id: null },
          targetType: 'installation',
          targetId: made.id,
          occurredAt: now,
        });
        return { id: made.id, created: true };
      }
      const [existing] = await inner
        .select({ id: installation.id })
        .from(installation)
        .limit(1);
      return { id: existing!.id, created: false };
    }),
  );
}
