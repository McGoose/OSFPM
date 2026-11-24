import { existsSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  readInstallationFacts,
  recordAdminCommandRun,
  type InstallationFacts,
} from '@osfpm/core/src/auth/admin-report.js';
import {
  countTotpSecrets,
  TOTP_SETTINGS,
  type TotpSecretCounts,
} from '@osfpm/core/src/auth/totp.js';
import { databaseTime, migrationStatus } from '@osfpm/core/src/db/status.js';
import {
  inspectKeyDirectory,
  type KeyDirectoryReport,
} from '@osfpm/core/src/keys/server-keys.js';
import { ConfigError, loadConfig, type Config } from '../config.js';
import {
  checkIdentityFile,
  readDataKeyState,
  type DataKeyState,
  type IdentityFileReport,
} from './key-state.js';
import {
  describeFailure,
  openAdminSession,
  type AdminContext,
  type AdminSession,
} from './session.js';

/**
 * The `doctor` command: runs each check of the installation and prints `ok`,
 * `warn` or `fail` with a one-line reason. A failing check makes the exit code 1,
 * a warning does not. A check that cannot run because an earlier one failed is
 * reported as skipped. It reads only, runs beside servers on PostgreSQL, never
 * migrates, and says what is wrong without printing a key, a key id, a secret, an
 * address or the database URL (CLAUDE.md, Data rules). It writes one
 * `admin.command-run` event when the database can take it, and says so in its
 * output when it cannot.
 */

/** How a check came out. */
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

/** The checks, in the order they run and are printed. A check's `id` is stable: `--json` carries it. */
export const DOCTOR_CHECKS = [
  { id: 'config', title: 'configuration loads' },
  { id: 'database', title: 'database reachable' },
  { id: 'migrations', title: 'migrations up to date' },
  { id: 'setup', title: 'setup complete' },
  {
    id: 'key-directory',
    title: 'key directory exists and its key files are private',
  },
  { id: 'identity', title: 'identity file matches the stored key' },
  { id: 'data-keys', title: 'data keys present when secrets are sealed' },
  { id: 'secrets', title: 'every sealed secret can be opened' },
  { id: 'public-url', title: 'public URL uses HTTPS' },
  { id: 'clock', title: 'clock agrees with the database' },
  { id: 'disk', title: 'free disk space' },
] as const;

/** The id of one of `DOCTOR_CHECKS`. */
export type CheckId = (typeof DOCTOR_CHECKS)[number]['id'];

/** What a check found: how it came out, and one line why. */
type Finding = { readonly status: CheckStatus; readonly reason: string };

/** The result of one check. */
export type CheckResult = Finding & {
  readonly id: CheckId;
  readonly title: string;
};

/** Below this share of free space, in percent, the disk of a data or key directory is a warning. */
export const MIN_FREE_DISK_PERCENT = 10;

/**
 * The hosts that may use plain `http`: the same two as the server's own rule
 * (`LOCAL_HOSTS` in `config.ts`, which already refuses `http` anywhere else when it
 * loads the settings, so the warning below is a second line of defence).
 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/**
 * The check for the public URL: HTTPS, or plain `http` on this machine only. A
 * warning for plain `http` anywhere else, because passkeys and the `__Host-`
 * session cookie need HTTPS. The reason never repeats the address.
 */
export function publicUrlCheck(publicOrigin: string): Finding {
  let url: URL;
  try {
    url = new URL(publicOrigin);
  } catch {
    return { status: 'fail', reason: 'it is not a URL' };
  }
  if (url.protocol === 'https:') {
    return { status: 'ok', reason: 'it uses https' };
  }
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) {
    return {
      status: 'ok',
      reason: 'it is plain http on this machine, which is for development only',
    };
  }
  return {
    status: 'warn',
    reason:
      'it is plain http on a host other than localhost: passkeys and the __Host- session cookie need https',
  };
}

/**
 * The check for the clock: how far the local clock is from the database's, against
 * one authenticator code period (`TOTP_SETTINGS.periodSeconds`). A code is checked
 * against the server's time, so a clock that is further off than a period makes
 * correct codes fail. `localMs` is the local time as the midpoint of the two
 * readings taken either side of the database's answer, which takes the delay of the
 * question out of the difference.
 */
export function clockCheck(databaseMs: number, localMs: number): Finding {
  const skewSeconds = Math.abs(databaseMs - localMs) / 1000;
  const limit = TOTP_SETTINGS.periodSeconds;
  return skewSeconds > limit
    ? {
        status: 'warn',
        reason: `the local clock is ${Math.round(skewSeconds)} seconds from the database's, more than one authenticator code period (${limit} seconds): correct codes may be refused`,
      }
    : { status: 'ok', reason: `within ${limit} seconds` };
}

/** The percentage of the space on the disk that holds `path` that is free, or null when it cannot be read. */
function freePercent(path: string): number | null {
  // The folder may not be made yet: ask about the nearest one that is.
  let at = path;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  try {
    const stats = statfsSync(at);
    return stats.blocks === 0
      ? null
      : (Number(stats.bavail) / Number(stats.blocks)) * 100;
  } catch {
    return null;
  }
}

/**
 * The check for free disk space on the folders this installation writes to: a
 * warning when any has less than `MIN_FREE_DISK_PERCENT` free, or cannot be read.
 * `freeSpace` answers the free share of a folder's disk in percent, or null; it
 * defaults to the system's own, and tests pass theirs.
 */
export function diskCheck(
  folders: readonly { name: string; path: string }[],
  freeSpace: (path: string) => number | null = freePercent,
): Finding {
  const lines: string[] = [];
  let status: CheckStatus = 'ok';
  for (const folder of folders) {
    const free = freeSpace(folder.path);
    if (free === null) {
      status = 'warn';
      lines.push(`${folder.name}: could not be read`);
    } else {
      if (free < MIN_FREE_DISK_PERCENT) status = 'warn';
      // A decimal below the limit, where the difference between 0 and 0.4 matters.
      const shown =
        free < MIN_FREE_DISK_PERCENT
          ? free.toFixed(1)
          : String(Math.round(free));
      lines.push(`${folder.name}: ${shown} % free`);
    }
  }
  return {
    status,
    reason:
      status === 'ok'
        ? lines.join('; ')
        : `${lines.join('; ')} (less than ${MIN_FREE_DISK_PERCENT} % free is a warning)`,
  };
}

/** What the database says that the key directory check needs. */
type KeyFacts = {
  readonly facts: InstallationFacts;
  readonly secrets: TotpSecretCounts;
};

/** The check on the key directory itself, with what the database says about whether it is needed. */
function keyDirectoryCheck(
  report: KeyDirectoryReport,
  database: KeyFacts | null,
): Finding {
  const needed =
    database === null
      ? null
      : database.facts.storedPublicKey !== null || database.secrets.sealed > 0;
  if (!report.exists) {
    if (needed === false) {
      return {
        status: 'warn',
        reason: 'it does not exist yet; the server makes it at its first start',
      };
    }
    return needed === true
      ? {
          status: 'fail',
          reason:
            'it does not exist, but this installation needs its keys: restore the key directory from your backup',
        }
      : { status: 'warn', reason: 'it does not exist' };
  }
  if (report.openFiles !== null && report.openFiles > 0) {
    const many = report.openFiles !== 1;
    return {
      status: 'fail',
      reason: `${report.openFiles} key file${many ? 's are' : ' is'} readable by other users: restrict ${many ? 'them' : 'it'} to the owner (mode 600) or the server refuses to start`,
    };
  }
  return report.openFiles === null
    ? {
        status: 'ok',
        reason:
          'it exists (file modes cannot be checked on Windows: protect the folder with its access rules)',
      }
    : { status: 'ok', reason: 'it exists and its key files are private' };
}

/** The check that the identity file is the one the installation stored. */
function identityCheck(file: IdentityFileReport): Finding {
  switch (file.state) {
    case 'matches':
      return { status: 'ok', reason: 'it is the stored key' };
    case 'not-stored':
      return {
        status: 'warn',
        reason:
          'no identity key is stored yet; the server binds one at its next start',
      };
    case 'does-not-match':
      return {
        status: 'fail',
        reason:
          'the file holds another key than the one this installation stored, so it is the wrong key directory: the server refuses to start',
      };
    case 'missing':
      return {
        status: 'fail',
        reason:
          'the file is missing but this installation stored a key: restore it from your backup, or, with no backup, replace the identity (new-identity)',
      };
    case 'unusable':
      return {
        status: 'fail',
        reason: `the file cannot be used (${file.problem ?? 'unreadable'}): the server refuses to start`,
      };
  }
}

/** The check that the data keys are there when a secret needs them. */
function dataKeysCheck(keys: DataKeyState, secrets: TotpSecretCounts): Finding {
  if (keys.problem !== null) {
    return {
      status: 'fail',
      reason: `a data key file cannot be used (${keys.problem}): the server refuses to start`,
    };
  }
  if (keys.ring !== null) return { status: 'ok', reason: 'they are there' };
  return secrets.sealed > 0
    ? {
        status: 'fail',
        reason: `the data keys are gone, but ${secrets.sealed} authenticator secret${secrets.sealed === 1 ? ' is' : 's are'} sealed with them: restore the key directory from your backup, or, with no backup, accept the loss (accept-data-key-loss)`,
      }
    : {
        status: 'ok',
        reason:
          'none are there, and none are needed: the server makes them at its next start',
      };
}

/** The check that every sealed secret can be opened. */
function secretsCheck(secrets: TotpSecretCounts): Finding {
  if (secrets.unopenable === 0) {
    return {
      status: 'ok',
      reason: `${secrets.sealed} sealed, all can be opened`,
    };
  }
  return {
    status: 'warn',
    reason: `${secrets.unopenable} of ${secrets.sealed} sealed secret${secrets.sealed === 1 ? '' : 's'} cannot be opened: the people who set them up sign in another way and set up their authenticator app again`,
  };
}

/** What `doctor` prints, as `--json` prints it. */
export type DoctorReport = {
  readonly command: 'doctor';
  readonly checks: readonly CheckResult[];
  readonly summary: Record<CheckStatus, number>;
  /** Whether the `admin.command-run` event was written, and if not, why. */
  readonly audit: {
    readonly recorded: boolean;
    readonly reason: string | null;
  };
};

/** How many checks came out each way. */
function summarise(
  checks: readonly CheckResult[],
): Record<CheckStatus, number> {
  const summary: Record<CheckStatus, number> = {
    ok: 0,
    warn: 0,
    fail: 0,
    skipped: 0,
  };
  for (const check of checks) summary[check.status] += 1;
  return summary;
}

/** The text of a report: a line for each check, the audit line and the totals. */
function textOf(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((check) => check.title.length));
  const lines = report.checks.map(
    (check) =>
      `${check.status.padEnd(8)}${check.title.padEnd(width)}  ${check.reason}`,
  );
  const { ok, warn, fail, skipped } = report.summary;
  lines.push(
    '',
    report.audit.recorded
      ? 'Audit: one admin.command-run event was written.'
      : `Audit: no event was written (${report.audit.reason ?? 'unknown'}).`,
    `${ok} ok, ${warn} warn, ${fail} fail, ${skipped} skipped`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Runs `doctor`. Each check is made in the order of `DOCTOR_CHECKS`; a check whose
 * input is missing because an earlier one failed is skipped, with the reason. The
 * report goes to standard output as text, or JSON with `--json`. Exit code 1 when
 * any check failed, else 0. When the database answers and its migrations are
 * applied it writes one `admin.command-run` event with the totals; when it cannot,
 * the report says so.
 *
 * @throws Error only for what is not a check's business (a bug): every failure a
 * check can find is a result, not an exception.
 */
export async function runDoctor(
  input: { readonly json: boolean },
  context: AdminContext,
): Promise<number> {
  const now = context.now ?? (() => new Date());
  const found = new Map<CheckId, Finding>();
  const record = (id: CheckId, finding: Finding) => void found.set(id, finding);

  // 1. The settings.
  let config: Config | undefined;
  try {
    config = loadConfig(context.env);
    record('config', { status: 'ok', reason: 'the settings are valid' });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // The problems name variables and rules, never a value.
    record('config', { status: 'fail', reason: error.problems.join('; ') });
  }

  let session: AdminSession | undefined;
  try {
    if (config !== undefined) {
      const { keysDir } = config;
      const keyDirectory = inspectKeyDirectory(keysDir);
      const dataKeys = readDataKeyState(keysDir);

      // 2. The database, marked as in use for a read.
      try {
        session = await openAdminSession(config, context, 'read-only-command');
        record('database', {
          status: 'ok',
          reason: `it answers (${config.database.driver})`,
        });
      } catch (error) {
        record('database', { status: 'fail', reason: describeFailure(error) });
      }

      let keyFacts: KeyFacts | null = null;
      if (session !== undefined) {
        const open = session.database;
        try {
          // 3. The migrations.
          const migrations = await migrationStatus(open.db);
          if (migrations.pending > 0) {
            record('migrations', {
              status: 'fail',
              reason: `${migrations.pending} pending: start the server once, which applies them (unless OSFPM_AUTO_MIGRATE is false)`,
            });
          } else {
            record('migrations', {
              status: 'ok',
              reason: `${migrations.applied} applied, none pending`,
            });
            // 4, 6, 7 and 8: what the database says.
            const read = await open.db.transaction(async (tx) => ({
              facts: await readInstallationFacts(tx),
              secrets: await countTotpSecrets(tx, dataKeys.ring),
            }));
            keyFacts = read;
            const { facts, secrets } = read;
            if (facts.installationId === null) {
              record('setup', {
                status: 'warn',
                reason:
                  'no installation yet: the server has not started on this database',
              });
            } else if (facts.setupCompletedAt === null) {
              record('setup', {
                status: 'warn',
                reason: 'first-run setup is not complete yet',
              });
            } else {
              record('setup', {
                status: 'ok',
                reason: `complete since ${facts.setupCompletedAt.toISOString()}`,
              });
            }
            record(
              'identity',
              identityCheck(checkIdentityFile(keysDir, facts.storedPublicKey)),
            );
            record('data-keys', dataKeysCheck(dataKeys, secrets));
            record('secrets', secretsCheck(secrets));
          }
          // 10. The clock: the database's answer between two readings of the local one.
          const before = now().getTime();
          const databaseMs = (await databaseTime(open.db)).getTime();
          const after = now().getTime();
          record('clock', clockCheck(databaseMs, (before + after) / 2));
        } catch (error) {
          // A check that needed the database and could not have it.
          record('database', {
            status: 'fail',
            reason: describeFailure(error),
          });
        }
      }

      // 5. The key directory, with the database's word on whether it is needed if it gave one.
      record('key-directory', keyDirectoryCheck(keyDirectory, keyFacts));
      // 9 and 11 need the settings only.
      record('public-url', publicUrlCheck(config.publicOrigin));
      const target = config.database;
      record(
        'disk',
        diskCheck(
          [
            ...(target.driver === 'pglite' && !target.dataDir.includes('://')
              ? [{ name: 'data directory', path: target.dataDir }]
              : []),
            { name: 'key directory', path: keysDir },
          ],
          context.freeSpace,
        ),
      );
    }

    // What has no result was skipped, and the reason says why it could not run.
    const checks: CheckResult[] = DOCTOR_CHECKS.map(({ id, title }) => {
      const finding = found.get(id);
      if (finding !== undefined) return { id, title, ...finding };
      return {
        id,
        title,
        status: 'skipped',
        reason:
          config === undefined
            ? 'needs valid settings'
            : found.get('migrations')?.status === 'fail'
              ? 'needs the migrations to be applied'
              : 'needs the database',
      };
    });
    const summary = summarise(checks);

    // The audit event: written when the database is there with its migrations applied.
    let audit: DoctorReport['audit'];
    if (session === undefined) {
      audit = {
        recorded: false,
        reason:
          config === undefined
            ? 'the settings are not valid, so there is no database to write to'
            : 'the database could not be reached',
      };
    } else if (found.get('migrations')?.status !== 'ok') {
      audit = {
        recorded: false,
        reason:
          'the migrations are not applied, so there is no audit log to write to',
      };
    } else {
      try {
        await session.database.db.transaction(async (tx) => {
          const facts = await readInstallationFacts(tx);
          await recordAdminCommandRun(tx, {
            command: 'doctor',
            outcome: 'completed',
            installationId: facts.installationId,
            details: { ...summary },
            now: now(),
          });
        });
        audit = { recorded: true, reason: null };
      } catch {
        audit = { recorded: false, reason: 'the event could not be saved' };
      }
    }

    const report: DoctorReport = { command: 'doctor', checks, summary, audit };
    context.stdout.write(
      input.json ? `${JSON.stringify(report, null, 2)}\n` : textOf(report),
    );
    return summary.fail > 0 ? 1 : 0;
  } finally {
    await session?.close();
  }
}
