import type { SensitiveCategory } from './schemas.js';

/** What a call on a person's sensitive data was denied for. */
export type SensitiveOperation =
  'read' | 'write' | 'delete' | 'grant' | 'revoke';

/** The caller may not do this. Carries no person id and no values. */
export class SensitiveAccessDeniedError extends Error {
  constructor(
    readonly category: SensitiveCategory,
    readonly operation: SensitiveOperation,
  ) {
    super(`Access to sensitive ${category} data denied for ${operation}`);
    this.name = 'SensitiveAccessDeniedError';
  }
}

/** The payload does not fit its category. Lists where and why, never what. */
export class SensitivePayloadInvalidError extends Error {
  constructor(
    readonly category: SensitiveCategory,
    readonly issues: readonly { path: string; code: string }[],
  ) {
    super(
      `Invalid ${category} payload` +
        (issues.length > 0
          ? ` at: ${issues.map((i) => i.path || '(root)').join(', ')}`
          : ''),
    );
    this.name = 'SensitivePayloadInvalidError';
  }
}

/**
 * The person has an account, so their access needs live in their access profile and
 * cannot be written as a production record (decision D-69). Nothing was written. It
 * carries nothing: not the person, not a field.
 */
export class UseAccessProfileError extends Error {
  constructor() {
    super('A person with an account keeps their access needs in their profile');
    this.name = 'UseAccessProfileError';
  }
}

/**
 * The role cannot be granted access: it does not exist in this organisation, was
 * deleted, or belongs to another project. One error and one answer for all of those, so
 * the answer says nothing about which role ids exist. Nothing was written.
 */
export class RoleNotAvailableError extends Error {
  constructor() {
    super('The role is not available for this project');
    this.name = 'RoleNotAvailableError';
  }
}

/**
 * The account is deleted, so nothing can be shared from it and nothing made for sharing
 * (decision D-69): a grant, a share with the usual roles and its preview, and an access
 * profile are refused for it. A person with an account is the only one who makes any of
 * these for it, so only the holder of the account is ever told this, and it carries nothing:
 * not the person, not the project. Nothing was written but the audit event of the refusal.
 */
export class AccountDeletedError extends Error {
  constructor() {
    super('The account is deleted');
    this.name = 'AccountDeletedError';
  }
}

/**
 * The reasons a rule of the access needs model refuses a call, from a closed list: they
 * are the only codes written to the audit trail for a refusal, so no free text, and with
 * it no field name or value, can reach it.
 */
export const ACCESS_REFUSAL_REASONS = [
  'use-access-profile',
  'role-not-available',
  'account-deleted',
  'category-not-grantable',
  'invalid-fields',
  'invalid-groups',
  'consent-required',
  'consent-not-allowed',
  'consent-invalid',
  'person-not-on-project',
  'project-closed',
] as const;
/** One value of `ACCESS_REFUSAL_REASONS`. */
export type AccessRefusalReason = (typeof ACCESS_REFUSAL_REASONS)[number];

/** The reasons `AccessGrantRefusedError` carries: the ones that have no class of their own. */
export type AccessGrantRefusal = Exclude<
  AccessRefusalReason,
  'use-access-profile' | 'role-not-available' | 'account-deleted'
>;

/**
 * A rule of the grant model refused the call (decision D-69): a field that is not one a
 * grant can name, a consent record that is missing or not allowed, a person who is not on
 * the project, or a project that is wrapped or closed. It carries the reason code only,
 * never a field name, a value or a note. Nothing was written.
 */
export class AccessGrantRefusedError extends Error {
  constructor(readonly reason: AccessGrantRefusal) {
    super(`Access grant refused: ${reason}`);
    this.name = 'AccessGrantRefusedError';
  }
}

/** The person already has an access profile, so one cannot be created again; they update it. */
export class AccessProfileExistsError extends Error {
  constructor() {
    super('The access profile already exists');
    this.name = 'AccessProfileExistsError';
  }
}

/**
 * Two changes to one grant (the same person, category and role on a project) arrived at
 * the same moment and this one lost, so it wrote nothing. Reading the grant again and
 * trying once more is safe.
 */
export class AccessGrantBusyError extends Error {
  constructor() {
    super('The access grant was changed at the same moment');
    this.name = 'AccessGrantBusyError';
  }
}
