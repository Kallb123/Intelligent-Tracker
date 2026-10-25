import { describe, expect, it } from 'vitest';
import { addLocalDays, localToday, milestoneDay, startOfLocalDay } from './day.js';
import { RecurrenceError } from './recurrence/errors.js';

describe('localToday', () => {
  it('uses the household zone, which can differ from the UTC date', () => {
    // 23:30 UTC on 1 July is already 2 July in London (BST) and in Tokyo, still 1 July in New York.
    const now = new Date('2026-07-01T23:30:00Z');
    expect(localToday(now)).toBe('2026-07-02');
    expect(localToday(now, 'Europe/London')).toBe('2026-07-02');
    expect(localToday(now, 'Asia/Tokyo')).toBe('2026-07-02');
    expect(localToday(now, 'America/New_York')).toBe('2026-07-01');
  });

  it('matches UTC in London winter and is one day behind before the clocks go forward', () => {
    expect(localToday(new Date('2026-01-15T23:59:59Z'))).toBe('2026-01-15');
    expect(localToday(new Date('2026-03-29T00:00:00Z'))).toBe('2026-03-29');
    expect(localToday(new Date('2026-03-28T23:59:59Z'))).toBe('2026-03-28');
  });

  it('rejects an unknown zone and an invalid instant', () => {
    expect(() => localToday(new Date(), 'Mars/Olympus')).toThrow(RecurrenceError);
    expect(() => localToday(new Date(Number.NaN))).toThrow(RecurrenceError);
  });
});

describe('startOfLocalDay', () => {
  it('is local midnight as an instant (BST is an hour ahead of UTC)', () => {
    expect(startOfLocalDay('2026-01-15').toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(startOfLocalDay('2026-07-01').toISOString()).toBe('2026-06-30T23:00:00.000Z');
    expect(startOfLocalDay('2026-07-01', 'America/New_York').toISOString()).toBe(
      '2026-07-01T04:00:00.000Z',
    );
  });

  it('is DST-safe: days are 23 or 25 hours long when the clocks change', () => {
    const hours = (day: string, next: string): number =>
      (startOfLocalDay(next).getTime() - startOfLocalDay(day).getTime()) / 3_600_000;
    expect(hours('2026-03-29', '2026-03-30')).toBe(23);
    expect(hours('2026-10-25', '2026-10-26')).toBe(25);
    expect(hours('2026-06-10', '2026-06-11')).toBe(24);
  });

  it('round-trips with localToday', () => {
    for (const day of ['2026-03-29', '2026-10-25', '2026-12-31']) {
      const start = startOfLocalDay(day);
      expect(localToday(start)).toBe(day);
      expect(localToday(new Date(start.getTime() - 1))).toBe(addLocalDays(day, -1));
    }
  });

  it('rejects impossible dates and unknown zones', () => {
    expect(() => startOfLocalDay('2026-02-30')).toThrow(RecurrenceError);
    expect(() => startOfLocalDay('2026-01-01', 'Mars/Olympus')).toThrow(RecurrenceError);
  });
});

describe('addLocalDays', () => {
  it('moves by calendar days across month, year and leap boundaries', () => {
    expect(addLocalDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addLocalDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addLocalDays('2026-03-28', 0)).toBe('2026-03-28');
    expect(addLocalDays('2026-03-28', 30)).toBe('2026-04-27');
  });

  it('rejects impossible dates', () => {
    expect(() => addLocalDays('2026-13-01', 1)).toThrow(RecurrenceError);
  });
});

describe('milestoneDay', () => {
  it('is the offset in calendar days before the due day', () => {
    expect(milestoneDay('2026-10-30', 0)).toBe('2026-10-30');
    expect(milestoneDay('2026-10-30', 7)).toBe('2026-10-23');
    expect(milestoneDay('2026-03-02', 3)).toBe('2026-02-27');
    expect(milestoneDay('2027-01-02', 5)).toBe('2026-12-28');
  });

  it('rejects impossible dates', () => {
    expect(() => milestoneDay('2026-13-01', 1)).toThrow(RecurrenceError);
  });
});
