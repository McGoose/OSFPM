import { describe, expect, it } from 'vitest';
import { API_PREFIX, API_VERSION } from './api-version.js';

describe('the API version', () => {
  it('puts every route under /api/<version>', () => {
    expect(API_VERSION).toBe('v1');
    expect(API_PREFIX).toBe('/api/v1');
  });
});
