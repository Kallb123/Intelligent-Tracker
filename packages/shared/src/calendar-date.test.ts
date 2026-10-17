import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  formatCalendarDate,
  formatDayHeading,
  MS_PER_DAY,
  parseUkDate,
} from './calendar-date.js';

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

describe('parseUkDate', () => {
  const today = '2026-10-17';

  it.each([
    ['25/12/2026', '2026-12-25'],
    ['5/11/2026', '2026-11-05'],
    ['05/11/26', '2026-11-05'],
    ['5-11-26', '2026-11-05'],
    ['5.11.2026', '2026-11-05'],
    ['  05/11/2026  ', '2026-11-05'],
    ['1/1/1999', '1999-01-01'],
    ['29/02/2028', '2028-02-29'],
  ])('reads %s day first, with a year', (text, expected) => {
    expect(parseUkDate(text, today)).toBe(expected);
  });

  it('takes the year in the text even when it is in the past', () => {
    expect(parseUkDate('1/1/2020', today)).toBe('2020-01-01');
  });

  it.each([
    ['25/12', '2026-12-25'],
    ['5/11', '2026-11-05'],
    ['5-11', '2026-11-05'],
    ['5.11', '2026-11-05'],
    ['12/10', '2027-10-12'],
    ['01/01', '2027-01-01'],
  ])('reads %s as the next such date', (text, expected) => {
    expect(parseUkDate(text, today)).toBe(expected);
  });

  it('counts today as on or after today', () => {
    expect(parseUkDate('17/10', today)).toBe('2026-10-17');
    expect(parseUkDate('16/10', today)).toBe('2027-10-16');
  });

  it('waits for the next leap year for 29 February', () => {
    expect(parseUkDate('29/02', today)).toBe('2028-02-29');
    expect(parseUkDate('29/02', '2028-02-29')).toBe('2028-02-29');
    expect(parseUkDate('29/02', '2028-03-01')).toBe('2032-02-29');
    // 2100 is not a leap year.
    expect(parseUkDate('29/02', '2096-03-01')).toBe('2104-02-29');
  });

  it.each([
    '',
    'tomorrow',
    '31/02',
    '31/04/2026',
    '29/02/2026',
    '32/01',
    '0/1',
    '1/0',
    '1/13',
    '1/1/1',
    '1/1/20266',
    '2026-11-05',
    '5/11-26',
    '5/11/',
    '5 11',
  ])('rejects %j', (text) => {
    expect(parseUkDate(text, today)).toBeNull();
  });
});

describe('daysBetween', () => {
  it('counts the whole days from one date to another', () => {
    expect(daysBetween('2026-10-12', '2026-10-12')).toBe(0);
    expect(daysBetween('2026-10-12', '2026-10-13')).toBe(1);
    expect(daysBetween('2026-12-30', '2027-01-04')).toBe(5);
  });

  it('is negative when the second date is earlier', () => {
    expect(daysBetween('2026-10-13', '2026-10-12')).toBe(-1);
  });

  it('is not thrown off by a daylight-saving change or a leap day', () => {
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
});

describe('MS_PER_DAY', () => {
  it('is the milliseconds in a day', () => {
    expect(MS_PER_DAY).toBe(86_400_000);
  });
});
