import { sql } from 'drizzle-orm';
import { seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { installation, user } from '../db/schema/index.js';

/**
 * Helpers for the auth tests. Fixtures insert straight into the tables, as the
 * other tests do (CLAUDE.md, Data rules); the code under test writes through
 * the auth service. Only tests import this file. People are invented.
 */

/** Adds the single `installation` row, which the auth services read for this server's id. */
export async function seedInstallation(database: Database): Promise<string> {
  const id = newId();
  await database.db
    .insert(installation)
    .values({ id, baseUrl: 'https://osfpm.example.test' });
  return id;
}

/** An active user with an invented address. */
export const seedActiveUser = seedUser;

/** A user in `status`, for the cases an active user does not cover. */
export async function seedUserWithStatus(
  database: Database,
  status: 'invited' | 'active' | 'disabled',
): Promise<string> {
  const id = await seedUser(database);
  await setUserStatus(database, id, status);
  return id;
}

/** Sets a user's status directly, bypassing the auth service. */
export async function setUserStatus(
  database: Database,
  userId: string,
  status: 'invited' | 'active' | 'disabled',
): Promise<void> {
  await database.db
    .update(user)
    .set({ status })
    .where(sql`${user.id} = ${userId}`);
}

type Row = Record<string, unknown>;

/** Runs a query and returns its rows, whichever driver is in use. */
export async function rowsOf(
  database: Database,
  query: ReturnType<typeof sql>,
): Promise<Row[]> {
  const result = (await database.db.execute(query)) as { rows: Row[] };
  return result.rows;
}

/**
 * Every row of every table in the database, as JSON text. Tests search it for a
 * raw token, code or password to show none was ever stored, in any table.
 */
export async function everyRowAsText(database: Database): Promise<string> {
  const tables = await rowsOf(
    database,
    sql`select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  const parts: string[] = [];
  for (const { table_name: name } of tables) {
    const found = await rowsOf(
      database,
      sql`select coalesce(string_agg(to_jsonb(t)::text, E'\n'), '') as text
          from ${sql.identifier(name as string)} t`,
    );
    parts.push(String(found[0]!.text));
  }
  return parts.join('\n');
}
