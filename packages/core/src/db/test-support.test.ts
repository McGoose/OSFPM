import { EventEmitter } from 'node:events';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { guardTeardown } from './test-support.js';

/** The error PostgreSQL sends to a connection that `drop database ... with (force)` closes. */
const shutdown = () =>
  Object.assign(
    new Error('terminating connection due to administrator command'),
    { code: '57P01' },
  );

/**
 * The guard that a test's own pool needs when the test drops its database with `force`.
 * A pool is made and never used, so nothing connects, and errors are put on it by hand.
 */
describe('guardTeardown', () => {
  const poolOf = () =>
    new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/nothing' });

  it('rethrows every error until the test says it is tearing down, as an unhandled pool error would fail the run', async () => {
    const pool = poolOf();
    guardTeardown(pool);
    expect(() => pool.emit('error', shutdown())).toThrow(
      'terminating connection',
    );
    await pool.end();
  });

  it('lets the shutdown error of a forced drop (57P01) pass once teardown has begun, on the pool and on its clients, and nothing else', async () => {
    const pool = poolOf();
    const beginTeardown = guardTeardown(pool);
    beginTeardown();
    expect(() => pool.emit('error', shutdown())).not.toThrow();
    // Any other error is still a failure of the run.
    expect(() => pool.emit('error', new Error('boom'))).toThrow('boom');
    expect(() =>
      pool.emit('error', Object.assign(new Error('lost'), { code: '08006' })),
    ).toThrow('lost');
    // A connection the pool makes gets the same handler.
    const client = new EventEmitter();
    pool.emit('connect', client);
    expect(() => client.emit('error', shutdown())).not.toThrow();
    expect(() => client.emit('error', new Error('boom'))).toThrow('boom');
    await pool.end();
  });
});
