import { describe, expect, it } from 'vitest';
import { AccessDeniedError } from './access-denied-error.js';

// Ids written out here so the tests can check they never reach the error.
const ORGANISATION_ID = '0196a1f0-0000-7000-8000-0000000000a1';
const PROJECT_ID = '0196a1f0-0000-7000-8000-0000000000b2';

describe('AccessDeniedError', () => {
  it('names the permission and says project for a scope with a project', () => {
    const error = new AccessDeniedError('contracts:edit', {
      organisationId: ORGANISATION_ID,
      projectId: PROJECT_ID,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'AccessDeniedError',
      permission: 'contracts:edit',
      scope: 'project',
    });
    expect(error.message).toContain('contracts:edit');
  });

  it('says organisation for a scope without a project', () => {
    const error = new AccessDeniedError('legal-hold:manage', {
      organisationId: ORGANISATION_ID,
      projectId: null,
    });
    expect(error).toMatchObject({
      permission: 'legal-hold:manage',
      scope: 'organisation',
    });
  });

  it('has no scope when none is given', () => {
    const error = new AccessDeniedError('contracts:read');
    expect(error.permission).toBe('contracts:read');
    expect(error.scope).toBeUndefined();
  });

  it('carries no ids, in its message or its fields', () => {
    const error = new AccessDeniedError('contracts:edit', {
      organisationId: ORGANISATION_ID,
      projectId: PROJECT_ID,
    });
    const everything = JSON.stringify({ ...error, message: error.message });
    expect(everything).not.toContain(ORGANISATION_ID);
    expect(everything).not.toContain(PROJECT_ID);
  });
});
