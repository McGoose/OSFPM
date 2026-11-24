import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const POSTGRES =
  'postgres://osfpm:hunter2-not-a-real-password@db.internal/osfpm';
const PUBLIC_URL = 'https://osfpm.example.test';

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

describe('OSFPM_KEYS_DIR', () => {
  it('is required with DATABASE_URL, with a fixed message that echoes no value', () => {
    const message = refusal({
      DATABASE_URL: POSTGRES,
      OSFPM_PUBLIC_URL: PUBLIC_URL,
    });
    expect(message).toContain('OSFPM_KEYS_DIR');
    expect(message).toContain('is required with DATABASE_URL');
    expect(message).toContain('backed up with the database');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('db.internal');
  });

  it('counts an empty value as not set', () => {
    expect(
      refusal({
        DATABASE_URL: POSTGRES,
        OSFPM_PUBLIC_URL: PUBLIC_URL,
        OSFPM_KEYS_DIR: '',
      }),
    ).toContain('is required with DATABASE_URL');
  });

  it('is taken as the key directory, made absolute, with DATABASE_URL', () => {
    expect(
      loadConfig({
        DATABASE_URL: POSTGRES,
        OSFPM_PUBLIC_URL: PUBLIC_URL,
        OSFPM_KEYS_DIR: './secrets/osfpm',
      }).keysDir,
    ).toBe(resolve('./secrets/osfpm'));
  });

  it('defaults to <OSFPM_DATA_DIR>/keys with PGlite', () => {
    expect(
      loadConfig({ OSFPM_DATA_DIR: './data', OSFPM_PUBLIC_URL: PUBLIC_URL })
        .keysDir,
    ).toBe(resolve('./data', 'keys'));
  });

  it('may be set with PGlite, and then replaces the default', () => {
    expect(
      loadConfig({
        OSFPM_DATA_DIR: './data',
        OSFPM_PUBLIC_URL: PUBLIC_URL,
        OSFPM_KEYS_DIR: './elsewhere',
      }).keysDir,
    ).toBe(resolve('./elsewhere'));
  });

  it('refuses a value with a NUL character, without repeating it', () => {
    const message = refusal({
      OSFPM_DATA_DIR: './data',
      OSFPM_PUBLIC_URL: PUBLIC_URL,
      OSFPM_KEYS_DIR: 'bad\0path',
    });
    expect(message).toContain('OSFPM_KEYS_DIR');
    expect(message).not.toContain('bad');
  });

  it('adds no second problem when neither database setting is given', () => {
    const message = refusal({ OSFPM_PUBLIC_URL: PUBLIC_URL });
    expect(message).toContain('Set DATABASE_URL');
    expect(message).not.toContain('is required with DATABASE_URL');
  });
});
