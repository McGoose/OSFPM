import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PGlite start-up and migration can exceed the 5-second default on a busy
    // machine, so database setup in tests and hooks gets 30 seconds.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
