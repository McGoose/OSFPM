import { sql } from 'drizzle-orm';
import type { Tx } from '../db/write.js';
import { permission } from '../db/schema/index.js';

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
 * nothing, and existing role grants stay. Modules call it at start-up.
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
