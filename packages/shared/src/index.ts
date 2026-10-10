/** Defaults applied to a newly created household (see docs/PLAN.md, section 10). */
export const HOUSEHOLD_DEFAULTS = {
  timezone: 'Europe/London',
  locale: 'en-GB',
  bankHolidayRegion: 'england-and-wales',
  icalPublicHost: 'calendar.kallum.uk',
  defaultReminderProfile: 'standard',
  slots: {
    morningDigest: '08:00',
    eveningDigest: '19:00',
  },
  quietHours: {
    start: '21:30',
    end: '07:30',
  },
} as const;

export type HouseholdDefaults = typeof HOUSEHOLD_DEFAULTS;

export * from './auth.js';
