import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';

describe('createDatabase', () => {
  it('opens an in-memory PGlite database when configured', async () => {
    const database = createDatabase({ driver: 'pglite' });
    const result = await database.db.execute(sql`select 1 as one`);
    expect(result.rows[0]).toEqual({ one: 1 });
    await database.close();
  });

  it('rejects an unknown driver without echoing the configuration', () => {
    const bad = { driver: 'sqlite', url: 'postgres://user:secret@host/db' };
    expect(() => createDatabase(bad as never)).toThrow(/sqlite/);
    expect(() => createDatabase(bad as never)).not.toThrow(/secret/);
  });
});
