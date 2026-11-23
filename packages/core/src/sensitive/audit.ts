import type { AccessCredential } from '../access/credential.js';

/**
 * The audit categories of the access needs model (decision D-69), besides
 * `sensitive.read` and `sensitive.denied`, which every read and denial of crew
 * personal data writes. The details of every one of these events hold ids, counts and
 * a reason code from a closed list, never a field name, a value or a consent note:
 * the name of a field alone can hint at a condition (CLAUDE.md, Privacy rule).
 */
export const ACCESS_AUDIT = {
  profileCreated: 'access.profile-created',
  profileUpdated: 'access.profile-updated',
  profileDeleted: 'access.profile-deleted',
  grantCreated: 'access.grant-created',
  grantRevoked: 'access.grant-revoked',
  shortcutUsed: 'access.shortcut-used',
  refused: 'access.refused',
} as const;

/** What the audit helpers need of a context: who acted, how, and when. */
export type AuditContext = {
  /** The user acting. */
  readonly userId: string;
  readonly requestId?: string | null;
  readonly clock: () => Date;
  /** A personal API token that made the request, if one did. */
  readonly credential?: AccessCredential;
};

/**
 * Who an event names as the actor: the token when a personal API token made the request,
 * which is who really did it, and the user otherwise (as `WriteContext` has it).
 */
export function auditActor(ctx: AuditContext) {
  return ctx.credential?.kind === 'token'
    ? ({ type: 'token', id: ctx.credential.tokenId } as const)
    : ({ type: 'user', id: ctx.userId } as const);
}

/** What a token adds to the details of an event: its id, and the owner it acted for. Nothing for a session. */
export function tokenMark(ctx: AuditContext): Record<string, string> {
  return ctx.credential?.kind === 'token'
    ? { tokenId: ctx.credential.tokenId, userId: ctx.userId }
    : {};
}
