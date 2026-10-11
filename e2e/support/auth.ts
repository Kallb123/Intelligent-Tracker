import { expect, type Page } from '@playwright/test';

/** The household and admin the smoke tests create on a fresh database. */
export const admin = {
  householdName: 'E2E Household',
  name: 'Ada Admin',
  username: 'ada',
  password: 'correct-horse-battery',
} as const;

/** Walks the first-run wizard at /setup (step 1: household and name, step 2: credentials). */
export async function completeSetup(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Welcome', level: 1 })).toBeVisible();

  await page.getByLabel('Household name').fill(admin.householdName);
  await page.getByLabel('Your name').fill(admin.name);
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByLabel('Username').fill(admin.username);
  await page.getByLabel('Password', { exact: true }).fill(admin.password);
  await page.getByLabel('Confirm password').fill(admin.password);
  await page.getByRole('button', { name: 'Create household' }).click();
}

/** Logs in on /login as the admin. */
export async function logIn(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Log in', level: 1 })).toBeVisible();

  await page.getByLabel('Username or email').fill(admin.username);
  await page.getByLabel('Password', { exact: true }).fill(admin.password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

/**
 * Opens the app and ends up on the Today page as the admin.
 *
 * On a fresh database `/` redirects to the setup wizard and this creates the household. If it
 * already exists (a retry of a failed test, or a second spec) it logs in instead, so every spec
 * can start with this call.
 */
export async function openAsAdmin(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/(setup|login)$/);

  if (new URL(page.url()).pathname === '/setup') await completeSetup(page);
  else await logIn(page);

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
}
