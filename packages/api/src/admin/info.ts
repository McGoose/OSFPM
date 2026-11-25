import {
  readInstallationFacts,
  recordAdminCommandRun,
} from '@osfpm/core/src/auth/admin-report.js';
import { countTotpSecrets } from '@osfpm/core/src/auth/totp.js';
import type { MigrationStatus } from '@osfpm/core/src/db/status.js';
import { inspectKeyDirectory } from '@osfpm/core/src/keys/server-keys.js';
import type { Config } from '../config.js';
import { PACKAGE_VERSION, PRODUCT_NAME } from '../package-info.js';
import {
  checkIdentityFile,
  readDataKeyState,
  type IdentityFileState,
} from './key-state.js';
import type { AdminContext, AdminSession } from './session.js';

/**
 * The `info` command: what this installation holds, in counts. It prints the
 * product and version, the installation's id, the database driver (never its
 * address), the migrations, the setup state, the stored identity key's fingerprint
 * and whether the key file matches it, how many data key files there are, how many
 * authenticator secrets are sealed, plain and sealed but unopenable, and how many
 * organisations and users there are. No names, no addresses, no keys and no key
 * ids (CLAUDE.md, Data rules). It writes one `admin.command-run` audit event.
 */

/** The report of `info`, which `--json` prints as it is. */
export type InfoReport = {
  readonly command: 'info';
  readonly product: string;
  readonly version: string;
  /** The id of this installation, or null before the server has made it. */
  readonly installationId: string | null;
  /** The database driver: `postgres` or `pglite`. Never the address. */
  readonly database: { readonly driver: 'postgres' | 'pglite' };
  readonly migrations: { readonly applied: number; readonly pending: number };
  readonly setup: {
    readonly complete: boolean;
    /** ISO 8601, UTC; null while setup is not complete. */
    readonly completedAt: string | null;
  };
  readonly identity: {
    /** The fingerprint of the stored identity public key, in groups of four; null before one is stored. */
    readonly storedFingerprint: string | null;
    /** How the key file compares with it. */
    readonly keyFile: IdentityFileState;
    /** For an unusable key file: `permissions`, `invalid` or `unreadable`. Otherwise null. */
    readonly keyFileProblem: string | null;
  };
  readonly dataKeys: { readonly files: number };
  readonly totpSecrets: {
    readonly sealed: number;
    readonly plain: number;
    /** Sealed secrets the data keys cannot open. Part of `sealed`. */
    readonly unopenable: number;
  };
  readonly organisations: number;
  readonly users: {
    readonly invited: number;
    readonly active: number;
    readonly disabled: number;
    readonly deleted: number;
  };
};

/** The words for each state of the identity key file. */
const KEY_FILE_TEXT: Record<IdentityFileState, string> = {
  matches: 'matches the stored key',
  'does-not-match': 'does NOT match the stored key',
  missing: 'is missing',
  'not-stored': 'cannot be compared: no key is stored yet',
  unusable: 'cannot be used',
};

/** `info` as the lines of text. */
function textOf(report: InfoReport): string {
  const unusable =
    report.identity.keyFileProblem === null
      ? ''
      : ` (${report.identity.keyFileProblem})`;
  return (
    [
      `${report.product} ${report.version}`,
      `Installation id: ${report.installationId ?? 'none yet (the server has not started on this database)'}`,
      `Database: ${report.database.driver}`,
      `Migrations: ${report.migrations.applied} applied, ${report.migrations.pending} pending`,
      report.setup.complete
        ? `Setup: complete since ${report.setup.completedAt}`
        : 'Setup: not complete',
      `Identity key: ${report.identity.storedFingerprint ?? 'none stored yet'}`,
      `Identity key file: ${KEY_FILE_TEXT[report.identity.keyFile]}${unusable}`,
      `Data key files: ${report.dataKeys.files}`,
      `Authenticator secrets: ${report.totpSecrets.sealed} sealed, ${report.totpSecrets.plain} plain, ${report.totpSecrets.unopenable} sealed but cannot be opened`,
      `Organisations: ${report.organisations}`,
      `Users: ${report.users.active} active, ${report.users.invited} invited, ${report.users.disabled} disabled, ${report.users.deleted} deleted`,
    ].join('\n') + '\n'
  );
}

/**
 * Runs `info`: reads, prints the report on standard output (text, or JSON with
 * `--json`) and writes one `admin.command-run` event with the counts. It changes
 * nothing else and runs beside servers on PostgreSQL. Exit code 0.
 *
 * @throws The database's own errors, which the caller reports by class name.
 */
export async function runInfo(
  input: {
    readonly json: boolean;
    readonly config: Config;
    readonly migrations: MigrationStatus;
  },
  session: AdminSession,
  context: AdminContext,
): Promise<number> {
  const { config, migrations } = input;
  const now = (context.now ?? (() => new Date()))();
  const keyDirectory = inspectKeyDirectory(config.keysDir);
  const dataKeys = readDataKeyState(config.keysDir);
  const report = await session.database.db.transaction(async (tx) => {
    const facts = await readInstallationFacts(tx);
    const secrets = await countTotpSecrets(tx, dataKeys.ring);
    const identityFile = checkIdentityFile(
      config.keysDir,
      facts.storedPublicKey,
    );
    const users = facts.users;
    await recordAdminCommandRun(tx, {
      command: 'info',
      outcome: 'completed',
      installationId: facts.installationId,
      details: {
        sealed: secrets.sealed,
        plain: secrets.plain,
        unopenable: secrets.unopenable,
        organisations: facts.organisations,
        users: users.invited + users.active + users.disabled,
      },
      now,
    });
    const result: InfoReport = {
      command: 'info',
      product: PRODUCT_NAME,
      version: PACKAGE_VERSION,
      installationId: facts.installationId,
      database: { driver: config.database.driver },
      migrations: { applied: migrations.applied, pending: migrations.pending },
      setup: {
        complete: facts.setupCompletedAt !== null,
        completedAt: facts.setupCompletedAt?.toISOString() ?? null,
      },
      identity: {
        storedFingerprint: facts.storedFingerprint,
        keyFile: identityFile.state,
        keyFileProblem: identityFile.problem,
      },
      dataKeys: { files: keyDirectory.dataKeyFiles },
      totpSecrets: {
        sealed: secrets.sealed,
        plain: secrets.plain,
        unopenable: secrets.unopenable,
      },
      organisations: facts.organisations,
      users: { ...users },
    };
    return result;
  });
  context.stdout.write(
    input.json ? `${JSON.stringify(report, null, 2)}\n` : textOf(report),
  );
  return 0;
}
