import { expect, test } from 'vitest';

import { OSFPM_CORE_VERSION } from './index.js';

test('exposes the placeholder core version', () => {
  expect(OSFPM_CORE_VERSION).toBe('0.0.0');
});
