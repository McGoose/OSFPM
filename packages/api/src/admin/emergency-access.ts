import {
  issueEmergencyAccess,
  type EmergencyAccessRefusal,
} from '@osfpm/core/src/auth/emergency-access.js';
import { accessResetLink } from '../access-reset/link.js';
import type { Config } from '../config.js';
import type { EmergencyAccessRequest } from './args.js';
import {
  AdminRefusal,
  type AdminContext,
  type AdminSession,
} from './session.js';

/**
 * The `emergency-access` command (P-09a2, decision D-81): the only way back in for an
 * organisation whose sole administrator has lost every way to sign in. It makes a
 * reset link as the system, for an owner of the organisation or a member who holds
 * its Administrator role, and prints it. The rules, the lock order and the audit are
 * the core's (`issueEmergencyAccess`); this file only asks and prints.
 *
 * The link is a secret, the one secret this command prints, and it goes to standard
 * error, outside any logger, once, after the transaction that made it has committed,
 * so a link on the screen is always one that exists. Standard output says only that a
 * link was printed, for which user id, and when it ends. A refusal prints one fixed
 * sentence that names no address, id or setting. The command only writes rows, so on
 * PostgreSQL it runs beside a running server.
 */

/**
 * What the operator is told for each reason no link was made. Fixed words: none
 * repeats what was typed, because an address pasted by mistake must not end up in a
 * terminal log, and none says more than the operator needs to put it right.
 */
const REFUSAL_TEXT: Readonly<Record<EmergencyAccessRefusal, string>> = {
  'installation-missing':
    'There is no installation on this database yet: the server has never started on it, so there is nobody to give access to.',
  'setup-incomplete':
    'First-run setup is not complete, so there is no administrator to help yet. Finish setup with the setup code the server prints when it starts.',
  'unknown-user': 'No account matches.',
  'user-not-active':
    'That account is not active: it is disabled, or only invited.',
  'organisation-required':
    'That person belongs to more than one organisation. Name the one with --organisation <id>.',
  'not-a-member': 'That person is not a member of the organisation.',
  'membership-not-active':
    'That person’s membership of the organisation is not active: it was removed, or is still only an invitation.',
  'not-an-administrator':
    'Only an owner of the organisation, or a member who holds its Administrator role, can be given an emergency access link. Anyone else is helped by their own administrator, with a reset link.',
  'link-busy':
    'Another request is using or revoking that person’s earlier link at this moment. Nothing was made. Run the command again.',
};

/**
 * The text the command prints on standard error for a link, a clearly marked block of
 * five lines ending in a newline: the link, who may have it, and how long it works.
 * This is the one place the link is turned into text for a person, and it goes to
 * standard error and nowhere else: never to standard output, the logger, an audit
 * event or an error (CLAUDE.md, Data rules).
 */
export function emergencyAccessBlock(link: string, expiresAt: Date): string {
  return (
    [
      '=== OSFPM emergency access ===',
      `Link: ${link}`,
      `Give it only to the person it is for. It works once and ends at ${expiresAt.toISOString()}.`,
      'It is not shown again: running the command again makes a new link and ends this one.',
      '==============================',
    ].join('\n') + '\n'
  );
}

/**
 * Runs `emergency-access`: asks the core for a link for the person named, in one
 * transaction, and on success prints the link on standard error and one sentence on
 * standard output. Exit code 0. The link is built with `accessResetLink`, the
 * function the route that makes a member's link uses.
 *
 * @throws AdminRefusal, with one fixed sentence, when no link was made (an unknown
 * account, one that is not active, an organisation to name, a person who is not an
 * owner or an Administrator, setup not complete). The refusal was audited as an
 * `admin.command-run` event in the transaction, which committed.
 */
export async function runEmergencyAccess(
  request: EmergencyAccessRequest,
  config: Config,
  session: AdminSession,
  context: AdminContext,
): Promise<number> {
  const now = (context.now ?? (() => new Date()))();
  const result = await session.database.db.transaction((tx) =>
    issueEmergencyAccess(
      tx,
      {
        person: request.person,
        ...(request.organisationId === null
          ? {}
          : { organisationId: request.organisationId }),
        ...(request.hours === null ? {} : { expiresInHours: request.hours }),
        removePasskeys: request.removePasskeys,
      },
      now,
    ),
  );
  if (!result.ok) throw new AdminRefusal(REFUSAL_TEXT[result.reason]);
  // Only now, with the link committed: a link on the screen is one that works.
  context.stderr.write(
    emergencyAccessBlock(
      accessResetLink(config.publicOrigin, result.token),
      result.reset.expiresAt,
    ),
  );
  context.stdout.write(
    `Printed an emergency access link for user ${result.reset.userId} on standard error. It expires at ${result.reset.expiresAt.toISOString()}.\n`,
  );
  return 0;
}
