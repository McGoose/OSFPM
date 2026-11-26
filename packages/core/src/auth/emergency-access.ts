import { and, asc, eq, isNull } from 'drizzle-orm';
import { installation, orgMembership } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { ResetLinkBusyError } from './access-reset-errors.js';
import {
  createSystemAccessReset,
  type AccessResetView,
  type SystemAccessResetResult,
  type SystemResetRefusal,
} from './access-reset.js';
import {
  findAdminPerson,
  recordAdminCommandRun,
  type AdminPerson,
} from './admin-report.js';
import { guardedAuth } from './shared.js';

/**
 * Emergency access (P-09a2, decision D-81): the one way back in for an organisation
 * whose sole administrator has lost every way to sign in. The admin command line
 * (`emergency-access`, decision D-64) asks for it with shell access to the server as
 * its authority, and gets a reset link that the system issued (E1): the same one-time
 * link, the same use and the same clearing as an administrator's reset link, with no
 * creator. Only an owner of the organisation, or a member who holds its managed
 * Administrator role, can be given one (E2): everyone else is helped by their own
 * administrator, with an ordinary reset link. Those rules are `checkSystemRules` in
 * `access-reset.ts`, and they are checked again when the link is used.
 *
 * What this file adds is the operator's side of it: finding the person and the
 * organisation from what a person can type, the checks that come before any link is
 * made (an installation that finished first-run setup), and an answer that is a
 * value, not an error, so the refusal can be audited and the command can print one
 * fixed sentence for it.
 */

/**
 * How long an emergency link works, in hours, unless the operator asks for another
 * number between `ACCESS_RESET_LIFETIME.minHours` and `maxHours`: an hour, because the
 * person who gets it is waiting for it and it is the strongest link there is. Not a
 * legal or financial number.
 */
export const EMERGENCY_ACCESS_DEFAULT_HOURS = 1;

/** What `issueEmergencyAccess` is given. */
export type EmergencyAccessInput = {
  /** The person the link is for, as the operator named them. */
  readonly person: AdminPerson;
  /**
   * The organisation, by id. Left out, it is the person's only organisation; a person
   * who belongs to more than one has to be told which.
   */
  readonly organisationId?: string;
  /** `EMERGENCY_ACCESS_DEFAULT_HOURS` when left out. */
  readonly expiresInHours?: number;
  /** Whether using the link also revokes every passkey of the person. False when left out. */
  readonly removePasskeys?: boolean;
};

/**
 * Why no link was made. A fixed list of words, so the audit event and the command's
 * message cannot carry what the operator typed.
 */
export const EMERGENCY_ACCESS_REFUSALS = [
  /** The database has no installation yet: the server has never started on it. */
  'installation-missing',
  /** First-run setup is not complete: there is no administrator to help yet. */
  'setup-incomplete',
  /** No account matches, or the account was deleted. */
  'unknown-user',
  /** The account is disabled or only invited. */
  'user-not-active',
  /** The person belongs to more than one organisation and none was named. */
  'organisation-required',
  /** The person is not a member of the organisation, or the organisation does not exist. */
  'not-a-member',
  /** The person's membership was removed, or is still only an invitation. */
  'membership-not-active',
  /** The person is neither an owner of the organisation nor a holder of its Administrator role. */
  'not-an-administrator',
  /** Another request is using or revoking the person's earlier link at this moment; try again. */
  'link-busy',
] as const;

/** One value of `EMERGENCY_ACCESS_REFUSALS`. */
export type EmergencyAccessRefusal = (typeof EMERGENCY_ACCESS_REFUSALS)[number];

/**
 * What `issueEmergencyAccess` answers: the link and its token, which exists nowhere
 * else, or why none was made.
 */
export type EmergencyAccessResult =
  | {
      readonly ok: true;
      readonly reset: AccessResetView;
      readonly token: string;
    }
  | { readonly ok: false; readonly reason: EmergencyAccessRefusal };

/** The words the reasons of `createSystemAccessReset` have here. */
function refusalOf(reason: SystemResetRefusal): EmergencyAccessRefusal {
  switch (reason) {
    case 'target-not-member':
      return 'not-a-member';
    case 'target-not-active':
      return 'user-not-active';
    case 'target-membership-not-active':
      return 'membership-not-active';
    case 'not-an-administrator':
      return 'not-an-administrator';
  }
}

/**
 * Makes an emergency access link for a person, or says why not. In order: the
 * installation exists and first-run setup is complete; the person is found (by
 * address, as typed, or by id; a deleted account is not found) and their account is
 * active; the organisation is the one named, or the person's only one (a live
 * membership row in any status counts, a deleted one does not); and then
 * `createSystemAccessReset` judges the person by the system's rules and makes the
 * link. The link lasts `expiresInHours`, or `EMERGENCY_ACCESS_DEFAULT_HOURS`.
 *
 * Every refusal is a returned value, not an error, and writes one
 * `admin.command-run` event (actor `system`, outcome `refused`, the command and one
 * reason from `EMERGENCY_ACCESS_REFUSALS`, and nothing that names the person or the
 * organisation), so the caller's transaction commits and the event survives. A link
 * writes no such event: its own events (`auth.access-reset-created`, from the system,
 * and one `auth.access-reset-revoked` for each earlier link it supersedes) are the
 * record, and the token is never in any of them.
 *
 * Checks no permission, because the caller is the operator's command line, run with
 * shell access to the server (decision D-64). It takes the person's user row and
 * supersedes earlier links exactly as `createAccessReset` does (it is the same code),
 * so it can run beside a server on PostgreSQL.
 *
 * @throws AuthInputError `expiresInHours` or `removePasskeys` for a value that is not
 * acceptable. It names the field and never the value. Nothing was written.
 * @throws RecordWriteError when the database refuses a read or a write; it carries
 * the SQLSTATE and constraint name only, never the token, its hash or an address.
 */
export async function issueEmergencyAccess(
  tx: Tx,
  input: EmergencyAccessInput,
  now: Date,
): Promise<EmergencyAccessResult> {
  const facts = await guardedAuth('installation', 'select', async () => {
    const [row] = await tx
      .select({
        id: installation.id,
        setupCompletedAt: installation.setupCompletedAt,
      })
      .from(installation)
      .limit(1);
    return row;
  });
  const refused = async (
    reason: EmergencyAccessRefusal,
  ): Promise<EmergencyAccessResult> => {
    await guardedAuth('audit_event', 'insert', () =>
      recordAdminCommandRun(tx, {
        command: 'emergency-access',
        outcome: 'refused',
        installationId: facts?.id ?? null,
        details: { reason },
        now,
      }),
    );
    return { ok: false, reason };
  };

  if (facts === undefined) return refused('installation-missing');
  if (facts.setupCompletedAt === null) return refused('setup-incomplete');

  const person = await findAdminPerson(tx, input.person);
  if (person === undefined) return refused('unknown-user');
  if (person.status !== 'active') return refused('user-not-active');

  let organisationId = input.organisationId;
  if (organisationId === undefined) {
    const memberships = await guardedAuth('org_membership', 'select', () =>
      tx
        .select({ organisationId: orgMembership.organisationId })
        .from(orgMembership)
        .where(
          and(
            eq(orgMembership.userId, person.id),
            isNull(orgMembership.deletedAt),
          ),
        )
        .orderBy(asc(orgMembership.organisationId)),
    );
    if (memberships.length === 0) return refused('not-a-member');
    if (memberships.length > 1) return refused('organisation-required');
    organisationId = memberships[0]!.organisationId;
  }

  let made: SystemAccessResetResult;
  try {
    made = await createSystemAccessReset(
      tx,
      organisationId,
      person.id,
      {
        expiresInHours: input.expiresInHours ?? EMERGENCY_ACCESS_DEFAULT_HOURS,
        ...(input.removePasskeys === undefined
          ? {}
          : { removePasskeys: input.removePasskeys }),
      },
      now,
    );
  } catch (error) {
    if (error instanceof ResetLinkBusyError) return refused('link-busy');
    throw error;
  }
  if (!made.ok) return refused(refusalOf(made.reason));
  return { ok: true, reset: made.reset, token: made.token };
}
