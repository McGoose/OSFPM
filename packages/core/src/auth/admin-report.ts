import { and, count, eq, isNotNull, isNull, type SQL } from 'drizzle-orm';
import {
  installation,
  organisation,
  user,
  type UserStatus,
} from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { publicKeyFingerprint } from '../keys/identity.js';
import { normaliseEmail } from './login-user.js';
import {
  AUTH_AUDIT,
  guardedAuth,
  recordAuthAudit,
  type AuthAuditDetails,
} from './shared.js';

/**
 * What the admin command line (`packages/api/src/admin/`, decision D-64) asks the
 * database about an installation, and the one audit event it writes for a command
 * that changes nothing. Only counts, the installation's id, dates and the public
 * key's fingerprint leave here: no name, no address and no key (CLAUDE.md,
 * Privacy rule). `findAdminPerson` turns what an operator types to name a person
 * into an account, as an id and a status. The commands that change keys are in
 * `server-key-admin.ts`, the one that makes emergency access links is in
 * `emergency-access.ts` and the one that ends sessions is in `admin-sessions.ts`.
 */

/** The commands of the admin command line, as the audit trail names them. */
export const ADMIN_COMMANDS = [
  'info',
  'doctor',
  'rotate-data-key',
  'accept-data-key-loss',
  'new-identity',
  'emergency-access',
  'revoke-sessions',
  'run-cleanups',
] as const;

/** One of `ADMIN_COMMANDS`. */
export type AdminCommand = (typeof ADMIN_COMMANDS)[number];

/** What an installation holds, as `readInstallationFacts` counts it. */
export type InstallationFacts = {
  /** The id of this installation (the server's id), or null before the server has made the row. */
  readonly installationId: string | null;
  /** When first-run setup finished, or null while it has not. */
  readonly setupCompletedAt: Date | null;
  /** The identity public key the installation stored (raw 32 bytes, base64url): public. Null before one was bound. */
  readonly storedPublicKey: string | null;
  /** `publicKeyFingerprint` of `storedPublicKey`. Public. */
  readonly storedFingerprint: string | null;
  /** The organisations that are not deleted. */
  readonly organisations: number;
  /** The users that are not deleted, by status, and how many are deleted. */
  readonly users: {
    readonly invited: number;
    readonly active: number;
    readonly disabled: number;
    readonly deleted: number;
  };
};

/**
 * Reads the facts about this installation that the admin command line reports:
 * its id, whether and when setup finished, the stored identity key, and how many
 * organisations and users there are. It lists the columns it needs and never
 * selects a user's row (CLAUDE.md, Data rules): no name and no address is read at
 * all. A read, which takes no lock; it checks no permission, because the command
 * line is the operator's, run with shell access to the server (decision D-64).
 *
 * @throws RecordWriteError when the database refuses a read; it carries the
 * SQLSTATE and constraint name only.
 */
export function readInstallationFacts(tx: Tx): Promise<InstallationFacts> {
  return guardedAuth('installation', 'read', async () => {
    const [row] = await tx
      .select({
        id: installation.id,
        serverPublicKey: installation.serverPublicKey,
        setupCompletedAt: installation.setupCompletedAt,
      })
      .from(installation)
      .limit(1);
    const [organisations] = await tx
      .select({ total: count() })
      .from(organisation)
      .where(isNull(organisation.deletedAt));
    const live = await tx
      .select({ status: user.status, total: count() })
      .from(user)
      .where(isNull(user.deletedAt))
      .groupBy(user.status);
    const [deleted] = await tx
      .select({ total: count() })
      .from(user)
      .where(isNotNull(user.deletedAt));
    const users = { invited: 0, active: 0, disabled: 0 };
    for (const { status, total } of live) {
      // The statuses are the CHECK's own list; a switch, not a lookup by the text.
      switch (status) {
        case 'invited':
          users.invited = total;
          break;
        case 'active':
          users.active = total;
          break;
        case 'disabled':
          users.disabled = total;
          break;
      }
    }
    const storedPublicKey = row?.serverPublicKey ?? null;
    return {
      installationId: row?.id ?? null,
      setupCompletedAt: row?.setupCompletedAt ?? null,
      storedPublicKey,
      storedFingerprint:
        storedPublicKey === null ? null : publicKeyFingerprint(storedPublicKey),
      organisations: organisations?.total ?? 0,
      users: { ...users, deleted: deleted?.total ?? 0 },
    };
  });
}

/**
 * The id of this installation, or null before the server has made it: what a command
 * that writes its own event needs to name the installation as that event's target,
 * without the counts `readInstallationFacts` reads. A read, which takes no lock; it
 * checks no permission (decision D-64).
 *
 * @throws RecordWriteError when the database refuses a read; it carries the
 * SQLSTATE and constraint name only.
 */
export function readInstallationId(tx: Tx): Promise<string | null> {
  return guardedAuth('installation', 'read', async () => {
    const [row] = await tx
      .select({ id: installation.id })
      .from(installation)
      .limit(1);
    return row?.id ?? null;
  });
}

/**
 * How an operator names a person on the admin command line: the address, as typed, or
 * the id of the account. The address is compared as the login services compare it
 * (trimmed and in lower case), and is never printed, logged or audited.
 */
export type AdminPerson =
  | { readonly kind: 'email'; readonly email: string }
  | { readonly kind: 'user'; readonly userId: string };

/** The account an operator named: its id and status, and nothing else about the person. */
export type FoundPerson = {
  readonly id: string;
  readonly status: UserStatus;
};

/** What a UUID looks like, so a value that is not one never reaches a `uuid` column. */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Finds the account an operator named, or `undefined` for an address no one has, an id
 * no one has, text that is not an id, and an account that was deleted, with one answer
 * for all. A disabled or invited account is found: it is the caller that refuses it,
 * with its own reason. Lists the columns it needs and never selects the whole row
 * (CLAUDE.md, Data rules), so no name and no address leaves here. A read, which takes
 * no lock; the caller locks the row where it matters. Checks no permission: the
 * command line is the operator's (decision D-64).
 *
 * @throws RecordWriteError when the database refuses a read; it carries the
 * SQLSTATE only, never the address.
 */
export function findAdminPerson(
  tx: Tx,
  person: AdminPerson,
): Promise<FoundPerson | undefined> {
  return guardedAuth('user', 'select', async () => {
    let match: SQL;
    if (person.kind === 'email') {
      match = eq(user.email, normaliseEmail(person.email));
    } else if (UUID_SHAPE.test(person.userId)) {
      match = eq(user.id, person.userId);
    } else {
      return undefined;
    }
    const [row] = await tx
      .select({ id: user.id, status: user.status })
      .from(user)
      .where(and(match, isNull(user.deletedAt)))
      .limit(1);
    return row;
  });
}

/** How a command ended, for `recordAdminCommandRun`. */
export type AdminOutcome =
  /** It did what it is for. */
  | 'completed'
  /** It looked, and there was nothing to do (a key command whose job was already done). */
  | 'nothing-to-do'
  /** It was refused for a reason about the installation's state, and changed nothing. */
  | 'refused';

/**
 * Writes the audit event `admin.command-run`, actor `system`, in the caller's
 * transaction: one for each command that reached the database and did not write an
 * event of its own. It names the command, how it ended and the counts the caller
 * gives, and the installation when there is one. `details` are counts, booleans and
 * fixed words only: the caller keeps every key, key id, secret, address and URL out
 * (CLAUDE.md, Data rules: the admin command line prints and audits counts, ids and
 * fingerprints and nothing else). Only the admin command line calls it.
 *
 * @throws RecordWriteError when the database refuses the row.
 */
export async function recordAdminCommandRun(
  tx: Tx,
  input: {
    command: AdminCommand;
    outcome: AdminOutcome;
    installationId: string | null;
    details?: AuthAuditDetails;
    now: Date;
  },
): Promise<void> {
  await recordAuthAudit(tx, {
    category: AUTH_AUDIT.adminCommandRun,
    action: 'run',
    actor: { type: 'system', id: null },
    targetType: input.installationId === null ? null : 'installation',
    targetId: input.installationId,
    // The name and the outcome last, so a detail of the caller's cannot replace them.
    details: {
      ...input.details,
      command: input.command,
      outcome: input.outcome,
    },
    occurredAt: input.now,
  });
}
