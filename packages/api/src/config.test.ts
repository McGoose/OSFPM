import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const POSTGRES =
  'postgres://osfpm:hunter2-not-a-real-password@db.internal/osfpm';

const PUBLIC_URL = 'https://osfpm.example.test';

/** A valid environment for a PostgreSQL install, which a test then changes. */
const BASE = { DATABASE_URL: POSTGRES, OSFPM_PUBLIC_URL: PUBLIC_URL };

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
    expect(loadConfig(BASE)).toEqual({
      database: { driver: 'postgres', url: POSTGRES },
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'info',
      publicOrigin: PUBLIC_URL,
      autoMigrate: true,
      trustedProxies: [],
    });
  });

  it('reads a small install from a data directory, and every setting', () => {
    expect(
      loadConfig({
        OSFPM_DATA_DIR: './data',
        OSFPM_PUBLIC_URL: 'https://films.example.test',
        OSFPM_AUTO_MIGRATE: 'false',
        HOST: '0.0.0.0',
        PORT: '8080',
        LOG_LEVEL: 'debug',
      }),
    ).toEqual({
      database: { driver: 'pglite', dataDir: './data' },
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'debug',
      publicOrigin: 'https://films.example.test',
      autoMigrate: false,
      trustedProxies: [],
    });
  });

  it('treats an empty variable as not set', () => {
    expect(loadConfig({ ...BASE, OSFPM_DATA_DIR: '', PORT: '' })).toMatchObject(
      { database: { driver: 'postgres' }, port: 3000 },
    );
  });

  it('refuses both DATABASE_URL and OSFPM_DATA_DIR, without echoing the URL', () => {
    const message = refusal({ ...BASE, OSFPM_DATA_DIR: './data' });
    expect(message).toContain('both set');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('db.internal');
    expect(message).not.toContain('./data');
  });

  it('refuses neither, and says what to set', () => {
    const message = refusal({ OSFPM_PUBLIC_URL: PUBLIC_URL });
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('OSFPM_DATA_DIR');
  });

  it('refuses a DATABASE_URL that is not a PostgreSQL URL, without echoing it', () => {
    const secret = 'mysql://user:hunter2-not-a-real-password@host/db';
    const message = refusal({ ...BASE, DATABASE_URL: secret });
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('mysql');
    expect(
      refusal({ ...BASE, DATABASE_URL: 'not a url hunter2' }),
    ).not.toContain('hunter2');
  });

  it.each([
    ['INFO', 'info'],
    ['Debug', 'debug'],
    ['WARN', 'warn'],
    ['SiLeNt', 'silent'],
  ])('reads LOG_LEVEL=%s as %s', (value, expected) => {
    expect(loadConfig({ ...BASE, LOG_LEVEL: value }).logLevel).toBe(expected);
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['PORT', '-1'],
    ['PORT', '80.5'],
    ['LOG_LEVEL', 'chatty'],
  ])('refuses %s=%s and names the variable only', (name, value) => {
    const message = refusal({ ...BASE, [name]: value });
    expect(message).toContain(name);
    expect(message).not.toContain(value);
    expect(message).not.toContain('hunter2');
  });

  it.each([
    ['whitespace only', '  '],
    ['exponent notation', '1e3'],
    ['padded', ' 80 '],
    ['hexadecimal', '0x50'],
    ['binary', '0b1010'],
    ['signed', '+80'],
    ['inside spaces', '8 0'],
    ['too many digits', '000080'],
  ])('refuses a PORT that is not plain digits: %s', (_label, value) => {
    expect(refusal({ ...BASE, PORT: value })).toContain('PORT');
  });

  it('accepts the lowest and highest port, and a port with a leading zero', () => {
    expect(loadConfig({ ...BASE, PORT: '0' }).port).toBe(0);
    expect(loadConfig({ ...BASE, PORT: '65535' }).port).toBe(65535);
    expect(loadConfig({ ...BASE, PORT: '080' }).port).toBe(80);
  });

  it('lists every problem at once', () => {
    const message = refusal({ PORT: 'abc', LOG_LEVEL: 'chatty' });
    expect(message).toContain('PORT');
    expect(message).toContain('LOG_LEVEL');
    expect(message).toContain('OSFPM_DATA_DIR');
    expect(message).toContain('OSFPM_PUBLIC_URL');
  });
});

describe('loadConfig: OSFPM_PUBLIC_URL', () => {
  const origin = (value: string) =>
    loadConfig({ ...BASE, OSFPM_PUBLIC_URL: value }).publicOrigin;

  it.each([
    ['https', 'https://osfpm.example.test', 'https://osfpm.example.test'],
    [
      'https with a port',
      'https://osfpm.example.test:8443',
      'https://osfpm.example.test:8443',
    ],
    ['localhost', 'http://localhost', 'http://localhost'],
    ['localhost with a port', 'http://localhost:3000', 'http://localhost:3000'],
    ['127.0.0.1', 'http://127.0.0.1', 'http://127.0.0.1'],
    ['127.0.0.1 with a port', 'http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['https on localhost', 'https://localhost:8443', 'https://localhost:8443'],
  ])('accepts %s', (_label, value, expected) => {
    expect(origin(value)).toBe(expected);
  });

  it('keeps only the origin: no path, query or fragment', () => {
    expect(origin('https://osfpm.example.test/app/?x=1#top')).toBe(
      'https://osfpm.example.test',
    );
  });

  it('writes the origin the way a browser sends it in the Origin header', () => {
    // Browsers send lower-case scheme and host, and leave out a default port.
    expect(origin('HTTPS://OSFPM.Example.TEST')).toBe(
      'https://osfpm.example.test',
    );
    expect(origin('https://osfpm.example.test:443')).toBe(
      'https://osfpm.example.test',
    );
    expect(origin('http://localhost:80')).toBe('http://localhost');
  });

  it.each([
    ['plain http on a public host', 'http://osfpm.example.test'],
    ['plain http on a private address', 'http://192.168.1.20:3000'],
    ['a host that only starts with localhost', 'http://localhost.example.test'],
    ['a host that only starts with 127.0.0.1', 'http://127.0.0.1.example.test'],
    ['localhost as a user name', 'http://localhost@example.test'],
    ['an IPv6 loopback address', 'http://[::1]:3000'],
    ['0.0.0.0', 'http://0.0.0.0:3000'],
    ['another scheme', 'ftp://osfpm.example.test'],
    ['no scheme', 'osfpm.example.test'],
    ['text that is not a URL', 'not a url'],
    ['a scheme and no host', 'https://:3000'],
  ])('refuses %s, without echoing it', (_label, value) => {
    const message = refusal({ ...BASE, OSFPM_PUBLIC_URL: value });
    expect(message).toContain('OSFPM_PUBLIC_URL');
    expect(message).not.toContain(value);
    expect(message).not.toContain('example.test');
    expect(message).not.toContain('192.168');
  });

  it('is required, and says what it is', () => {
    for (const env of [
      { DATABASE_URL: POSTGRES },
      { DATABASE_URL: POSTGRES, OSFPM_PUBLIC_URL: '' },
    ]) {
      const message = refusal(env);
      expect(message).toContain('OSFPM_PUBLIC_URL');
      expect(message).not.toContain('hunter2');
    }
  });
});

describe('loadConfig: OSFPM_AUTO_MIGRATE', () => {
  it('is on by default, and an empty value counts as not set', () => {
    expect(loadConfig(BASE).autoMigrate).toBe(true);
    expect(loadConfig({ ...BASE, OSFPM_AUTO_MIGRATE: '' }).autoMigrate).toBe(
      true,
    );
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['false', false],
    ['False', false],
  ])('reads %s as %s', (value, expected) => {
    expect(loadConfig({ ...BASE, OSFPM_AUTO_MIGRATE: value }).autoMigrate).toBe(
      expected,
    );
  });

  it.each(['yes', '1', '0', 'off', 'truee'])(
    'refuses %s and names the variable only',
    (value) => {
      const message = refusal({ ...BASE, OSFPM_AUTO_MIGRATE: value });
      expect(message).toContain('OSFPM_AUTO_MIGRATE');
      expect(message).not.toContain(value);
    },
  );
});

describe('loadConfig: OSFPM_TRUSTED_PROXIES', () => {
  const proxies = (value: string | undefined) =>
    loadConfig({
      ...BASE,
      ...(value === undefined ? {} : { OSFPM_TRUSTED_PROXIES: value }),
    }).trustedProxies;

  it('is off by default, and an empty value counts as not set', () => {
    expect(proxies(undefined)).toEqual([]);
    expect(proxies('')).toEqual([]);
  });

  it.each([
    ['an IPv4 address', '10.0.0.1', ['10.0.0.1']],
    ['an IPv6 address', 'fd00::1', ['fd00::1']],
    ['an IPv4 range', '10.0.0.0/8', ['10.0.0.0/8']],
    ['an IPv6 range', 'fd00::/8', ['fd00::/8']],
    [
      'the longest ranges',
      '10.0.0.1/32,fd00::1/128',
      ['10.0.0.1/32', 'fd00::1/128'],
    ],
    ['loopback', 'loopback', ['loopback']],
    ['linklocal', 'linklocal', ['linklocal']],
    ['uniquelocal', 'uniquelocal', ['uniquelocal']],
    [
      'a list',
      '10.0.0.1,192.168.0.0/16,loopback',
      ['10.0.0.1', '192.168.0.0/16', 'loopback'],
    ],
    ['a list with spaces', ' 10.0.0.1 , 10.0.0.2 ', ['10.0.0.1', '10.0.0.2']],
    ['a name in any case', 'LoopBack', ['loopback']],
  ])('reads %s', (_label, value, expected) => {
    expect(proxies(value)).toEqual(expected);
  });

  it.each([
    // Trusting every address lets any caller write its own address in the header.
    ['everything', '0.0.0.0/0'],
    ['every IPv6 address', '::/0'],
    ['a star', '*'],
    ['true', 'true'],
    ['a number of hops', '1'],
    ['a host name', 'proxy.internal.example.test'],
    ['a range with no prefix', '10.0.0.0/'],
    ['a prefix that is too long', '10.0.0.0/33'],
    ['an IPv6 prefix that is too long', 'fd00::/129'],
    ['a prefix that is not a number', '10.0.0.0/eight'],
    ['a negative prefix', '10.0.0.0/-8'],
    ['an address that is not one', '10.0.0.256'],
    ['one bad entry among good ones', '10.0.0.1,not-an-address'],
    ['an empty entry', '10.0.0.1,,10.0.0.2'],
    ['a trailing comma', '10.0.0.1,'],
    ['two slashes', '10.0.0.0/8/8'],
  ])('refuses %s, without echoing it', (_label, value) => {
    const message = refusal({ ...BASE, OSFPM_TRUSTED_PROXIES: value });
    expect(message).toContain('OSFPM_TRUSTED_PROXIES');
    expect(message).not.toContain(value);
    expect(message).not.toContain('not-an-address');
    expect(message).not.toContain('internal.example');
  });
});
