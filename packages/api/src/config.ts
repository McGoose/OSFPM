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

const environmentSchema = z.object({
  DATABASE_URL: z
    .string()
    .refine(isPostgresUrl, 'must be a postgres:// or postgresql:// URL')
    .optional(),
  OSFPM_DATA_DIR: z.string().optional(),
  HOST: z.string().default('127.0.0.1'),
  // 0 lets the operating system pick a free port, which tests rely on.
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

const VARIABLES = Object.keys(environmentSchema.shape);

/**
 * Reads and validates the configuration from `env` (the process environment
 * by default). Exactly one of `DATABASE_URL` (PostgreSQL) or `OSFPM_DATA_DIR`
 * (PGlite, for small installs) must be set. An empty variable counts as not
 * set, so an `.env` file may list a variable it leaves blank.
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
  };
}
