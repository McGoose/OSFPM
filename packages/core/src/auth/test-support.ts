import { eq, sql } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { ORIGIN, seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  installation,
  passwordCredential,
  totpCredential,
  user,
} from '../db/schema/index.js';
import { hashPassword } from './password.js';
import { normalisePassword } from './password-policy.js';

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

/** The stored email address of a user. */
export async function emailOf(
  database: Database,
  userId: string,
): Promise<string> {
  const [row] = await database.db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId));
  return row!.email;
}

/** Hashes are slow on purpose, so each distinct password is hashed once per test run. */
const hashesByPassword = new Map<string, Promise<string>>();

/**
 * Gives a user a password: inserts the `password_credential` row directly, as
 * fixtures do. The password is normalised first, as the services do, and hashed
 * once per distinct password. Invented passwords only.
 */
export async function seedPassword(
  database: Database,
  userId: string,
  password: string,
  options: { mustChange?: boolean; now?: Date } = {},
): Promise<void> {
  const normalised = normalisePassword(password);
  let hash = hashesByPassword.get(normalised);
  if (hash === undefined) {
    hash = hashPassword(normalised);
    hashesByPassword.set(normalised, hash);
  }
  await database.db.insert(passwordCredential).values({
    originServer: ORIGIN,
    userId,
    hash: await hash,
    changedAt: options.now ?? new Date(),
    mustChange: options.mustChange ?? false,
  });
}

/**
 * Gives a user an authenticator-app secret, confirmed unless `confirmed` is
 * false, and returns the secret in base32 so a test can make codes with
 * `totpCodeAt`.
 */
export async function seedTotp(
  database: Database,
  userId: string,
  options: { confirmed?: boolean; now?: Date } = {},
): Promise<string> {
  const secret = new Secret({ size: 20 }).base32;
  await database.db.insert(totpCredential).values({
    originServer: ORIGIN,
    userId,
    secret,
    confirmedAt:
      options.confirmed === false ? null : (options.now ?? new Date()),
  });
  return secret;
}

/** The authenticator code for `secret` at `time`, as an app would show it. */
export function totpCodeAt(secret: string, time: Date): string {
  return TOTP.generate({
    secret: Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    timestamp: time.getTime(),
  });
}

/** Marks a user deleted directly, bypassing the services, for the cases an active user does not cover. */
export async function markUserDeleted(
  database: Database,
  userId: string,
  at: Date = new Date(),
): Promise<void> {
  await database.db
    .update(user)
    .set({ deletedAt: at })
    .where(eq(user.id, userId));
}
