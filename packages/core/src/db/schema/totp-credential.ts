import { bigint, foreignKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { baseColumns, securityTable, timestamptz } from '../columns.js';
import { markSensitive } from '../sensitive.js';
import { user } from './user.js';

/**
 * A user's authenticator-app secret, one row per user. `secret` is marked
 * sensitive: no service returns it again after `enrolTotp` showed it once when
 * it was made, and it never appears in logs, events or errors (CLAUDE.md,
 * Privacy rule). `last_used_step` is the last accepted
 * time step, so a code cannot be used twice. A row with `confirmed_at` NULL is
 * still being set up and does not count at sign-in.
 *
 * A security table: written only by the auth service, directly, and each
 * change is audited (CLAUDE.md, Data rules). Only `auth/totp.ts` writes it.
 */
export const totpCredential = securityTable(
  'totp_credential',
  {
    ...baseColumns(() => user.id),
    userId: uuid('user_id').notNull(),
    secret: text('secret').notNull(),
    confirmedAt: timestamptz('confirmed_at'),
    lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  },
  (t) => [
    foreignKey({
      name: 'totp_credential_user_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }),
    unique('totp_credential_user_unique').on(t.userId),
  ],
);

markSensitive(totpCredential, ['secret']);
