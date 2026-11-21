import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const POSTGRES =
  'postgres://osfpm:hunter2-not-a-real-password@db.internal/osfpm';

/** The message of the `ConfigError` that `loadConfig` throws for `env`. */
function refusal(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error('Expected loadConfig to refuse this environment');
}

describe('loadConfig', () => {
  it('reads a PostgreSQL install, with the defaults for the rest', () => {
    expect(loadConfig({ DATABASE_URL: POSTGRES })).toEqual({
      database: { driver: 'postgres', url: POSTGRES },
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'info',
    });
  });

  it('reads a small install from a data directory, and every setting', () => {
    expect(
      loadConfig({
        OSFPM_DATA_DIR: './data',
        HOST: '0.0.0.0',
        PORT: '8080',
        LOG_LEVEL: 'debug',
      }),
    ).toEqual({
      database: { driver: 'pglite', dataDir: './data' },
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'debug',
    });
  });

  it('treats an empty variable as not set', () => {
    expect(
      loadConfig({ DATABASE_URL: POSTGRES, OSFPM_DATA_DIR: '', PORT: '' }),
    ).toMatchObject({ database: { driver: 'postgres' }, port: 3000 });
  });

  it('refuses both DATABASE_URL and OSFPM_DATA_DIR, without echoing the URL', () => {
    const message = refusal({
      DATABASE_URL: POSTGRES,
      OSFPM_DATA_DIR: './data',
    });
    expect(message).toContain('both set');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('db.internal');
    expect(message).not.toContain('./data');
  });

  it('refuses neither, and says what to set', () => {
    const message = refusal({});
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('OSFPM_DATA_DIR');
  });

  it('refuses a DATABASE_URL that is not a PostgreSQL URL, without echoing it', () => {
    const secret = 'mysql://user:hunter2-not-a-real-password@host/db';
    const message = refusal({ DATABASE_URL: secret });
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('mysql');
    expect(refusal({ DATABASE_URL: 'not a url hunter2' })).not.toContain(
      'hunter2',
    );
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['PORT', '-1'],
    ['PORT', '80.5'],
    ['LOG_LEVEL', 'chatty'],
  ])('refuses %s=%s and names the variable only', (name, value) => {
    const message = refusal({ DATABASE_URL: POSTGRES, [name]: value });
    expect(message).toContain(name);
    expect(message).not.toContain(value);
    expect(message).not.toContain('hunter2');
  });

  it('lists every problem at once', () => {
    const message = refusal({ PORT: 'abc', LOG_LEVEL: 'chatty' });
    expect(message).toContain('PORT');
    expect(message).toContain('LOG_LEVEL');
    expect(message).toContain('OSFPM_DATA_DIR');
  });
});
