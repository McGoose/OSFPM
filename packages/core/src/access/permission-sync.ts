import { sql } from 'drizzle-orm';
import type { Tx } from '../db/write.js';
import { permission } from '../db/schema/index.js';

/**
 * One permission a module declares, as a row of the `permission` catalogue.
 * Set `grantsSensitive` for any permission that exposes sensitive data
 * (CLAUDE.md, Privacy rule).
 */
export type PermissionDefinition = {
  /** `module:action`, for example `sensitive:read:dietary`. */
  readonly key: string;
  readonly module: string;
  readonly description: string;
  /** Defaults to false. */
  readonly grantsSensitive?: boolean;
};

/**
 * Upserts catalogue rows: new keys are inserted, known keys get the current
 * module, description and `grants_sensitive`. Running it again changes
 * nothing, and existing role grants stay. Modules are meant to call it at
 * start-up; nothing does yet, so tests that need keys use `ensurePermissions`.
 * Checks no permission: only trusted start-up code calls it.
 *
 * @throws The database's own error when a key breaks the key-format CHECK.
 */
export async function syncPermissions(
  tx: Tx,
  list: readonly PermissionDefinition[],
): Promise<void> {
  if (list.length === 0) return;
  await tx
    .insert(permission)
    .values(
      list.map((p) => ({
        key: p.key,
        module: p.module,
        description: p.description,
        grantsSensitive: p.grantsSensitive ?? false,
      })),
    )
    .onConflictDoUpdate({
      target: permission.key,
      set: {
        module: sql`excluded.module`,
        description: sql`excluded.description`,
        grantsSensitive: sql`excluded.grants_sensitive`,
      },
    });
}
