import { PERMISSION_LISTS } from './permission-lists.js';
import type { PermissionAccess } from './permission-sync.js';

/** Built on first use, so this file and the lists it reads cannot form an import cycle. */
let classes: ReadonlyMap<string, PermissionAccess> | undefined;

/**
 * The class of a permission key, `read` or `write`, from the definition that
 * declares it (`PermissionDefinition.access`). A key that no list declares is
 * `write`: the answer fails closed, so a read-only API token is refused a key nobody
 * has classed (maintainer decision of 23 Nov, task P-03b5). Anyone may call it; it
 * reads nothing but the lists in code, and checks no permission.
 *
 * The keys are looked up in a `Map`, never in a plain object: a key comes from a
 * caller or from a token's scope, and `__proto__` or `constructor` must not find
 * anything (CLAUDE.md, Data rules).
 */
export function permissionAccess(key: string): PermissionAccess {
  classes ??= new Map(
    PERMISSION_LISTS.flat().map((entry) => [entry.key, entry.access] as const),
  );
  return classes.get(key) ?? 'write';
}
