import { user, type UserStatus } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { AuthInputError } from './errors.js';
import { normaliseEmail } from './login-user.js';
import { SESSION_USER_COLUMNS, type SessionUser } from './sessions.js';
import {
  AUTH_AUDIT,
  guardedAuth,
  isOneOf,
  recordAuthAudit,
  serverId,
  type AuthActor,
} from './shared.js';

/**
 * Creating a user account (SC-10). `user` is an install-level table written only
 * by the auth service (`SERVICE_WRITTEN_TABLES`), directly and never through the
 * write helper, and its changes are audited instead of change-logged (CLAUDE.md,
 * Data rules). A user holds no personal details beyond an address and a display
 * name: crew data belongs to `person` and `person_sensitive` (CLAUDE.md, Privacy
 * rule). These functions check no permission: the route or the flow that calls
 * them has decided who may. Pass the transaction handle.
 */

/** The statuses a new account may start in: invited, or active. A user is disabled later, by `disableUser`. */
const NEW_USER_STATUSES = ['invited', 'active'] as const;

/** The longest address an email can be (RFC 5321). */
const MAX_EMAIL_LENGTH = 320;

/** The longest display name a new account takes. */
const MAX_DISPLAY_NAME_LENGTH = 200;

/** One `@` with something on each side and no space, which is what the database insists on, and no more. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

/**
 * True when `email`, already normalised (`normaliseEmail`), is shaped like an
 * address a user can be created with: one `@` with something on each side, no
 * white space, at most 320 characters. A shape check only, as the database's own
 * (`user_email_normalised_check`), not a check that the address exists. Reads
 * nothing; anyone may call it.
 */
export function isEmailShaped(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE.test(email);
}

/**
 * Creates a user and answers who they are. The address is stored trimmed and in
 * lower case (`normaliseEmail`), so one account belongs to one address however it
 * was typed, and the display name is stored trimmed. The status is `active`
 * unless `invited` is asked for; a new account is never created disabled. The
 * row gets the id of this server as `origin_server` and no `created_by` unless a
 * user made the account (`actor`), and it has no password, authenticator or
 * passkey: the caller sets how the user signs in. Audited as `auth.user-created`
 * with the status and no address, from `actor` (the system unless a user did it).
 *
 * @throws AuthInputError `status` when it is not `invited` or `active`, `email`
 * when the address is not shaped like one, `displayName` when it is empty or
 * over 200 characters, `locale` or `timezone` when empty. The error names the
 * field and never the value; nothing was written.
 * @throws AuthStateError `installation-missing` before the installation row
 * exists.
 * @throws RecordWriteError when the database refuses the row, for example
 * because the address is taken (SQLSTATE 23505, constraint `user_email_unique`);
 * it carries the SQLSTATE and constraint name only, never the address.
 */
export async function createUser(
  tx: Tx,
  input: {
    email: string;
    displayName: string;
    locale: string;
    timezone: string;
    status?: Extract<UserStatus, 'invited' | 'active'>;
    /** Who made the account; the system when left out. */
    actor?: AuthActor;
    now: Date;
  },
): Promise<SessionUser> {
  const status = input.status ?? 'active';
  if (!isOneOf(NEW_USER_STATUSES, status)) throw new AuthInputError('status');
  const email =
    typeof input.email === 'string' ? normaliseEmail(input.email) : '';
  if (!isEmailShaped(email)) throw new AuthInputError('email');
  const displayName =
    typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (displayName === '' || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new AuthInputError('displayName');
  }
  if (typeof input.locale !== 'string' || input.locale === '') {
    throw new AuthInputError('locale');
  }
  if (typeof input.timezone !== 'string' || input.timezone === '') {
    throw new AuthInputError('timezone');
  }
  const { now } = input;
  const actor: AuthActor = input.actor ?? { type: 'system', id: null };
  const madeBy = actor.type === 'user' ? actor.id : null;
  return guardedAuth('user', 'insert', () =>
    // A savepoint: a failure leaves no user and no event.
    tx.transaction(async (inner) => {
      const origin = await serverId(inner);
      const [row] = await inner
        .insert(user)
        .values({
          originServer: origin,
          email,
          displayName,
          locale: input.locale,
          timezone: input.timezone,
          status,
          createdAt: now,
          updatedAt: now,
          createdBy: madeBy,
          updatedBy: madeBy,
        })
        .returning(SESSION_USER_COLUMNS);
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.userCreated,
        action: 'create',
        actor,
        targetType: 'user',
        targetId: row!.id,
        details: { status },
        occurredAt: now,
      });
      return row!;
    }),
  );
}
