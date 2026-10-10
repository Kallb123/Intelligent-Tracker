import { defineConfig } from 'vitest/config';

const recurrence = 'packages/core/src/recurrence/**';

export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*'],
    // In `projects` mode coverage is configured here, once, for every project. Only the
    // recurrence engine is gated for now (PLAN.md, PR 4: 100% branch coverage).
    coverage: {
      provider: 'v8',
      include: [`${recurrence}/*.ts`],
      exclude: ['**/*.test.ts', '**/test-util.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        [recurrence]: { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
