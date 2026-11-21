import { isIP } from 'node:net';
import { z } from 'zod';

/** The log levels the server accepts. `silent` turns logging off. */
export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

/** One of `LOG_LEVELS`. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The validated server configuration. `database` has the shape the core's
 * `createDatabase` takes, so it can be passed on as it is.
 */
export type Config = {
  readonly database:
    | { readonly driver: 'postgres'; readonly url: string }
    | { readonly driver: 'pglite'; readonly dataDir: string };
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  /**
   * The origin of `OSFPM_PUBLIC_URL`, written as a browser writes it in an
   * `Origin` header. It is the only origin allowed to send a state-changing
   * request that carries a session cookie.
   */
  readonly publicOrigin: string;
  /** Run pending migrations when the server starts (`OSFPM_AUTO_MIGRATE`). */
  readonly autoMigrate: boolean;
  /**
   * The reverse proxies whose `X-Forwarded-For` is believed (`OSFPM_TRUSTED_PROXIES`):
   * IP addresses, CIDR ranges, or the names `loopback`, `linklocal` and
   * `uniquelocal`. Empty, the default, believes no header and takes the address
   * of the connection.
   */
  readonly trustedProxies: readonly string[];
};

/**
 * The environment is not a valid configuration. The message lists each problem
 * by variable name and rule. It never repeats a value: `DATABASE_URL` holds a
 * password, and a data directory is a path.
 */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `Invalid configuration:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

/** Only the PostgreSQL URL schemes. A bare string is not guessed to be a database. */
function isPostgresUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'postgres:' || protocol === 'postgresql:';
  } catch {
    return false;
  }
}

/**
 * The hosts that may use plain `http`, for development on one machine. Browsers
 * that treat `http://localhost` as a secure context, as Chrome and Firefox do,
 * accept a `Secure` cookie there. Compared
 * against the parsed host name, never as a prefix of the text:
 * `http://localhost.example.org` and `http://localhost@example.org` are not
 * local.
 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/**
 * True for `https://…` and for `http://` on `localhost` or `127.0.0.1` with any
 * port. Anything else, including plain `http` on a public host, would send the
 * session cookie in the clear.
 */
function isAllowedPublicUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    return (
      protocol === 'https:' ||
      (protocol === 'http:' && LOCAL_HOSTS.has(hostname))
    );
  } catch {
    return false;
  }
}

/** The names `proxy-addr`, which Fastify uses, accepts for a group of addresses. */
const PROXY_RANGE_NAMES: ReadonlySet<string> = new Set([
  'loopback',
  'linklocal',
  'uniquelocal',
]);

/**
 * True for one entry of `OSFPM_TRUSTED_PROXIES`: an IP address, a CIDR range with
 * a prefix from 1 to the length of the address, or one of `PROXY_RANGE_NAMES`.
 * A range of `/0` is refused, because trusting every address lets any caller
 * write its own in the header. A host name is refused: it would have to be
 * looked up, and the answer could change.
 */
function isTrustedProxyEntry(entry: string): boolean {
  if (PROXY_RANGE_NAMES.has(entry)) return true;
  const parts = entry.split('/');
  if (parts.length > 2) return false;
  const [address, prefix] = parts;
  const version = isIP(address ?? '');
  if (version === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const length = Number(prefix);
  return length >= 1 && length <= (version === 4 ? 32 : 128);
}

/** The entries of `OSFPM_TRUSTED_PROXIES`, trimmed, and the names in lower case. */
function proxyEntries(value: string): string[] {
  return value.split(',').map((entry) => {
    const trimmed = entry.trim();
    return PROXY_RANGE_NAMES.has(trimmed.toLowerCase())
      ? trimmed.toLowerCase()
      : trimmed;
  });
}

const environmentSchema = z.object({
  DATABASE_URL: z
    .string()
    .refine(isPostgresUrl, 'must be a postgres:// or postgresql:// URL')
    .optional(),
  OSFPM_DATA_DIR: z.string().optional(),
  HOST: z.string().default('127.0.0.1'),
  // Plain digits only: `Number()` would also take '  ' (as 0, a random port),
  // '1e3', ' 80 ' and '0x50'. 0 lets the operating system pick a free port,
  // which tests rely on.
  PORT: z
    .string()
    .refine(
      (value) => /^\d{1,5}$/.test(value) && Number(value) <= 65535,
      'must be a whole number from 0 to 65535',
    )
    .transform(Number)
    .default(3000),
  // Any case, because `LOG_LEVEL=INFO` is what people type. The value is
  // lowercased before it is checked, and a wrong one is not repeated.
  LOG_LEVEL: z
    .string()
    .transform((value) => value.toLowerCase())
    .pipe(z.enum(LOG_LEVELS))
    .default('info'),
  // The text of a wrong value is never repeated: a refine message is fixed.
  OSFPM_PUBLIC_URL: z
    .string(
      'is required: the URL users open, such as https://osfpm.example.org',
    )
    .refine(
      isAllowedPublicUrl,
      'must be an https:// URL, or http://localhost or http://127.0.0.1 with any port',
    ),
  // `true` or `false` in any case, like LOG_LEVEL. Other spellings (`1`, `yes`)
  // are refused rather than guessed: a typo must not skip the migrations.
  OSFPM_AUTO_MIGRATE: z
    .string()
    .transform((value) => value.toLowerCase())
    .pipe(z.enum(['true', 'false']))
    .transform((value) => value === 'true')
    .default(true),
  // A list, so a refused entry cannot be named without echoing it: the message
  // is fixed, and has no example in it that a value could be mistaken for.
  OSFPM_TRUSTED_PROXIES: z
    .string()
    .refine(
      (value) => proxyEntries(value).every(isTrustedProxyEntry),
      'must be a comma-separated list of IP addresses, CIDR ranges (never a range of everything), or the names loopback, linklocal and uniquelocal',
    )
    .transform(proxyEntries)
    .default([]),
});

const VARIABLES = Object.keys(environmentSchema.shape);

/**
 * Reads and validates the configuration from `env` (the process environment
 * by default). Exactly one of `DATABASE_URL` (PostgreSQL) or `OSFPM_DATA_DIR`
 * (PGlite, for small installs) must be set, and so must `OSFPM_PUBLIC_URL`.
 * An empty variable counts as not set, so an `.env` file may list a variable
 * it leaves blank.
 *
 * @throws ConfigError listing every problem found. The server entry prints it
 * and stops. Values are never part of the message.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Config {
  const raw: Record<string, string> = {};
  for (const name of VARIABLES) {
    const value = env[name];
    if (value !== undefined && value !== '') raw[name] = value;
  }

  const problems: string[] = [];
  const parsed = environmentSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }
  const hasUrl = raw.DATABASE_URL !== undefined;
  const hasDataDir = raw.OSFPM_DATA_DIR !== undefined;
  if (hasUrl && hasDataDir) {
    problems.push(
      'DATABASE_URL and OSFPM_DATA_DIR are both set: set exactly one',
    );
  } else if (!hasUrl && !hasDataDir) {
    problems.push(
      'Set DATABASE_URL (PostgreSQL) or OSFPM_DATA_DIR (PGlite, for small installs)',
    );
  }
  if (!parsed.success || problems.length > 0) throw new ConfigError(problems);

  const values = parsed.data;
  return {
    database:
      values.DATABASE_URL !== undefined
        ? { driver: 'postgres', url: values.DATABASE_URL }
        : { driver: 'pglite', dataDir: values.OSFPM_DATA_DIR! },
    host: values.HOST,
    port: values.PORT,
    logLevel: values.LOG_LEVEL,
    // `origin` is the form a browser sends: lower case, default port left out.
    publicOrigin: new URL(values.OSFPM_PUBLIC_URL).origin,
    autoMigrate: values.OSFPM_AUTO_MIGRATE,
    trustedProxies: values.OSFPM_TRUSTED_PROXIES,
  };
}
