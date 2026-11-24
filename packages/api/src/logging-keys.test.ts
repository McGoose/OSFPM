import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { SERVER_KEY_FILES } from '@osfpm/core/src/keys/server-keys.js';
import { loggerOptions, REDACTED } from './logging.js';

/** A value that must never reach a log line. */
const SECRET = 'key-marker-3c9a';

/** A private key as PEM text, the shape a careless message could carry. */
const PEM = `-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI${SECRET}\n-----END PRIVATE KEY-----\n`;

/** The real logger options, writing to `lines`, and nothing else around them. */
async function logger(removed: 'redact'[] = []) {
  const lines: string[] = [];
  const options = {
    ...(loggerOptions({
      level: 'info',
      stream: { write: (line) => void lines.push(line) },
    }) as Record<string, unknown>),
  };
  for (const name of removed) delete options[name];
  const app = Fastify({ logger: options as never });
  await app.ready();
  return { app, lines };
}

describe('key material in a log line', () => {
  it('masks a key named like key material or a secret, at any depth, in any case', async () => {
    const { app, lines } = await logger();
    app.log.info(
      {
        privateKey: `${SECRET}-a`,
        nested: {
          deeper: { DataKeys: [`${SECRET}-b`], dataKey: `${SECRET}-c` },
        },
        secret: `${SECRET}-d`,
        identity_key: `${SECRET}-e`,
        keyMaterial: `${SECRET}-f`,
        status: 'kept',
      },
      'a line written by hand',
    );
    await app.close();
    const log = lines.join('');
    expect(log).not.toContain(SECRET);
    expect(log).toContain(REDACTED);
    // What is not secret is still there.
    expect(log).toContain('kept');
  });

  it('masks a private key as PEM text wherever it sits in a string, whole', async () => {
    const { app, lines } = await logger();
    app.log.info({ field: PEM, other: 'kept' }, `the file said ${PEM}`);
    app.log.info(`plain message with ${PEM} inside`);
    await app.close();
    const log = lines.join('');
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('PRIVATE KEY');
    expect(log).not.toContain('MC4CAQ');
    expect(log).toContain('kept');
  });

  it('masks the name of the identity file and of a data key file, wherever a string names them', async () => {
    const { app, lines } = await logger();
    app.log.info(
      {
        path: `/srv/osfpm/keys/${SERVER_KEY_FILES.identity}`,
        folder: `/srv/osfpm/keys/${SERVER_KEY_FILES.dataKeysDirectory}/01900000-0000-7000-8000-000000000001.key`,
        other: 'kept',
      },
      `could not read /srv/osfpm/keys/${SERVER_KEY_FILES.identity}`,
    );
    await app.close();
    const log = lines.join('');
    expect(log).not.toContain(SERVER_KEY_FILES.identity);
    expect(log).not.toContain(SERVER_KEY_FILES.dataKeysDirectory);
    expect(log).not.toContain('01900000-0000-7000-8000-000000000001');
    expect(log).toContain('kept');
  });

  it('does it in the formatter, so the redact paths are not what the guarantee rests on', async () => {
    const { app, lines } = await logger(['redact']);
    app.log.info({ privateKey: SECRET, text: PEM }, 'by hand');
    await app.close();
    expect(lines.join('')).not.toContain(SECRET);
  });

  it('logs an error that carries a key as its class name only', async () => {
    const { app, lines } = await logger();
    app.log.error(
      { err: Object.assign(new Error(PEM), { privateKey: SECRET }) },
      'the key was refused',
    );
    app.log.error(new Error(`${PEM} and ${SECRET}`));
    await app.close();
    expect(lines.join('')).not.toContain(SECRET);
    expect(lines.join('')).not.toContain('PRIVATE KEY');
  });
});
