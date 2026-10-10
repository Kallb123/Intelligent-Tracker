import { HOUSEHOLD_DEFAULTS } from '@tracker/shared';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './index.js';

const tables = {
  household: schema.household,
  member: schema.member,
  session: schema.session,
  password_token: schema.passwordToken,
  bank_holiday: schema.bankHoliday,
  task: schema.task,
  task_assignee: schema.taskAssignee,
  task_milestone: schema.taskMilestone,
  occurrence: schema.occurrence,
  activity: schema.activity,
};

describe('schema', () => {
  it('names each table in snake_case', () => {
    for (const [name, table] of Object.entries(tables)) {
      expect(getTableConfig(table).name).toBe(name);
    }
  });

  it('takes household defaults from HOUSEHOLD_DEFAULTS', () => {
    const { columns } = getTableConfig(schema.household);
    const defaults = Object.fromEntries(columns.map((c) => [c.name, c.default]));
    expect(defaults).toMatchObject({
      timezone: HOUSEHOLD_DEFAULTS.timezone,
      locale: HOUSEHOLD_DEFAULTS.locale,
      bank_holiday_region: HOUSEHOLD_DEFAULTS.bankHolidayRegion,
      ical_public_host: HOUSEHOLD_DEFAULTS.icalPublicHost,
      default_reminder_profile: HOUSEHOLD_DEFAULTS.defaultReminderProfile,
      morning_slot: HOUSEHOLD_DEFAULTS.slots.morningDigest,
      evening_slot: HOUSEHOLD_DEFAULTS.slots.eveningDigest,
      quiet_hours_start: HOUSEHOLD_DEFAULTS.quietHours.start,
      quiet_hours_end: HOUSEHOLD_DEFAULTS.quietHours.end,
    });
  });

  it('generates a distinct iCal token for each member', () => {
    const column = getTableConfig(schema.member).columns.find((c) => c.name === 'ical_token');
    const make = column?.defaultFn as (() => string) | undefined;
    expect(make).toBeTypeOf('function');
    const [a, b] = [make?.(), make?.()];
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });
});
