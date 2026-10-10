import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests create a database and run every migration, which can be slow on CI.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
