import { describe, expect, it } from 'vitest';
import { HOUSEHOLD_DEFAULTS } from './index.js';

describe('HOUSEHOLD_DEFAULTS', () => {
  it('uses UK defaults', () => {
    expect(HOUSEHOLD_DEFAULTS.timezone).toBe('Europe/London');
    expect(HOUSEHOLD_DEFAULTS.locale).toBe('en-GB');
    expect(HOUSEHOLD_DEFAULTS.slots.eveningDigest).toBe('19:00');
  });

  it('defaults to England and Wales bank holidays and the standard reminder profile', () => {
    expect(HOUSEHOLD_DEFAULTS.bankHolidayRegion).toBe('england-and-wales');
    expect(HOUSEHOLD_DEFAULTS.icalPublicHost).toBe('calendar.kallum.uk');
    expect(HOUSEHOLD_DEFAULTS.defaultReminderProfile).toBe('standard');
  });
});
