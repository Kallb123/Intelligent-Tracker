import { describe, expect, it } from 'vitest';
import { formatCalendarDate, formatDayHeading } from './calendar-date.js';

describe('formatCalendarDate', () => {
  it('reads a bare date as a calendar date, whatever zone the browser is in', () => {
    expect(formatCalendarDate('2026-11-01')).toBe('1 Nov 2026');
    expect(formatCalendarDate('2026-12-31')).toBe('31 Dec 2026');
  });

  it('returns an empty string for anything that is not a date', () => {
    expect(formatCalendarDate('')).toBe('');
    expect(formatCalendarDate('2026-02-30')).toBe('');
    expect(formatCalendarDate('01/11/2026')).toBe('');
  });
});

describe('formatDayHeading', () => {
  it('shows the weekday, day and month', () => {
    expect(formatDayHeading('2026-10-12')).toBe('Mon 12 Oct');
    expect(formatDayHeading('2026-10-12', '2026-10-11')).toBe('Mon 12 Oct');
  });

  it('adds the year when it is not the current one, or when asked', () => {
    expect(formatDayHeading('2027-01-04', '2026-12-30')).toBe('Mon 4 Jan 2027');
    expect(formatDayHeading('2026-10-12', undefined, true)).toBe('Mon 12 Oct 2026');
    expect(formatDayHeading('nonsense')).toBe('');
  });
});
