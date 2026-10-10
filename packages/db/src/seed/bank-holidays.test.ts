import { describe, expect, it } from 'vitest';
import { ENGLAND_AND_WALES_BANK_HOLIDAYS as holidays } from './bank-holidays.js';

describe('England and Wales bank holiday data', () => {
  it('uses ISO dates that exist on the calendar', () => {
    for (const { date } of holidays) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(date);
    }
  });

  it('is sorted by date with no duplicates', () => {
    const dates = holidays.map((h) => h.date);
    expect(dates).toEqual([...new Set(dates)].sort());
  });

  it('only contains England and Wales entries with titles', () => {
    for (const h of holidays) {
      expect(h.region).toBe('england-and-wales');
      expect(h.title.trim()).not.toBe('');
    }
  });

  it('has no weekend dates', () => {
    for (const { date } of holidays) {
      expect([0, 6]).not.toContain(new Date(`${date}T00:00:00Z`).getUTCDay());
    }
  });

  it('covers 2025 onwards and has a Christmas Day entry each year', () => {
    const years = [...new Set(holidays.map((h) => h.date.slice(0, 4)))];
    expect(Number(years[0])).toBeGreaterThanOrEqual(2025);
    // The feed lists a substitute day (not 25 Dec) when Christmas falls on a weekend.
    for (const year of years) {
      const christmas = holidays.filter(
        (h) => h.date.startsWith(year) && /Christmas Day/.test(h.title),
      );
      expect(christmas, year).toHaveLength(1);
    }
  });
});
