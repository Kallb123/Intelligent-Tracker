import { defineConfig } from 'vitest/config';

const recurrence = 'packages/core/src/recurrence/**';
const rotation = 'packages/core/src/rotation/**';
const reminders = 'packages/core/src/reminders/**';

export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*'],
    // In `projects` mode coverage is configured here, once, for every project. Only the
    // recurrence engine, rotation and reminder planner are gated (PLAN.md, PR 4: 100% branch coverage).
    coverage: {
      provider: 'v8',
      include: [`${recurrence}/*.ts`, `${rotation}/*.ts`, `${reminders}/*.ts`],
      exclude: ['**/*.test.ts', '**/test-util.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        [recurrence]: { statements: 100, branches: 100, functions: 100, lines: 100 },
        [rotation]: { statements: 100, branches: 100, functions: 100, lines: 100 },
        [reminders]: { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
