import { defineConfig, devices } from '@playwright/test';

const ci = !!process.env['CI'];

/**
 * End-to-end tests run against an already-running stack (Docker Compose behind Caddy, or the
 * scripts/e2e-local.sh stack). Point them elsewhere with E2E_BASE_URL.
 *
 * The first-run flow needs a FRESH database: setup only works while no household exists.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  // Specs share one database and the first one creates the household, so run them in order.
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? 'list' : [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:8080',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
