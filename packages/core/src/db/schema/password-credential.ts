import { boolean, foreignKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { baseColumns, securityTable, timestamptz } from '../columns.js';
import { user } from './user.js';

/**
 * A user's password, one row per user. `hash` is an Argon2id hash in PHC string
 * format (see `auth/password.ts`), never the password. `must_change` forces a
 * new password at the next sign-in. The password policy is in
 * `auth/password-policy.ts`.
 *
 * A security table: only `auth/password-service.ts` writes it, directly, and
 * each change is audited (CLAUDE.md, Data rules).
 */
export const passwordCredential = securityTable(
  'password_credential',
  {
    ...baseColumns(() => user.id),
    userId: uuid('user_id').notNull(),
    hash: text('hash').notNull(),
    changedAt: timestamptz('changed_at').notNull(),
    mustChange: boolean('must_change').notNull().default(false),
  },
  (t) => [
    foreignKey({
      name: 'password_credential_user_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }),
    unique('password_credential_user_unique').on(t.userId),
  ],
);
