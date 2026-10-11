import { expect, test } from '@playwright/test';
import { admin, completeSetup, logIn, openAsAdmin } from '../support/auth.js';

// Needs a fresh database: setup is only open while no household exists (see README).

test('first run: the setup wizard creates the household and lands on Today', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);

  await completeSetup(page);

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  const header = page.getByRole('banner');
  await expect(header.getByRole('link', { name: admin.householdName })).toBeVisible();
  await expect(header.getByRole('button', { name: admin.name })).toBeVisible();
});

test('once set up, a logged-out visitor is sent to log in and lands on Today', async ({ page }) => {
  // Each test gets a fresh browser context (no cookie), and the test above created the household.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  await logIn(page);

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
});

test('create a weekly task and complete it', async ({ page }) => {
  const title = `Put the bins out ${Date.now()}`;
  // The first occurrence is today only if the ticked weekday is today (household time zone).
  const weekday = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    timeZone: 'Europe/London',
  }).format(new Date());

  await openAsAdmin(page);

  await page.getByRole('button', { name: 'New task' }).click();
  await expect(page).toHaveURL(/\/tasks\/new$/);
  await expect(page.getByRole('heading', { name: 'New task', level: 1 })).toBeVisible();

  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Repeats').selectOption('Weekly');
  await page.getByLabel(weekday, { exact: true }).check();

  const preview = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Next 5 dates' }),
  });
  await expect(preview.locator('ol > li')).toHaveCount(5);

  await page.getByRole('button', { name: 'Save task' }).click();

  await expect(page).toHaveURL(/\/tasks$/);
  const taskRow = page.getByRole('listitem').filter({ hasText: title });
  await expect(taskRow).toContainText(`Every week on ${weekday}`);

  // It is due today, so it is on the Today page; completing it removes it from the list.
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  const todayRow = page.getByRole('listitem').filter({ hasText: title });
  await expect(todayRow).toBeVisible();

  await page.getByRole('button', { name: `Complete ${title}` }).click();
  await expect(todayRow).toHaveCount(0);

  // The next week's occurrence was materialised and is waiting under Coming up.
  await page.goto('/upcoming');
  await expect(page.getByRole('listitem').filter({ hasText: title }).first()).toBeVisible();
});
