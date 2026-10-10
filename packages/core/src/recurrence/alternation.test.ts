import { describe, expect, it } from 'vitest';
import { alternationIndex } from './alternation.js';
import { rrules } from './builders.js';
import { expand } from './expand.js';
import { allDay, at, timed } from './test-util.js';
import type { FixedSchedule } from './types.js';

describe('alternationIndex', () => {
  // Bins: collected every Thursday, recycling and general waste in alternate weeks.
  const bins: FixedSchedule = {
    kind: 'fixed',
    rrule: rrules.weekly(['TH']),
    start: allDay('2026-10-01'),
  };

  it('alternates 0, 1, 0, 1 ... by occurrence', () => {
    expect(alternationIndex(bins, allDay('2026-10-01'), 2)).toBe(0);
    expect(alternationIndex(bins, allDay('2026-10-08'), 2)).toBe(1);
    expect(alternationIndex(bins, allDay('2026-10-15'), 2)).toBe(0);
    expect(alternationIndex(bins, allDay('2026-10-22'), 2)).toBe(1);
    expect(alternationIndex(bins, allDay('2026-10-22'), 3)).toBe(0);
  });

  it('returns null for a date that is not an occurrence', () => {
    expect(alternationIndex(bins, allDay('2026-10-02'), 2)).toBeNull();
    expect(alternationIndex(bins, allDay('2026-09-24'), 2)).toBeNull();
  });

  it('does not confuse an all-day due with a timed due', () => {
    expect(alternationIndex(bins, timed('2026-10-08T00:00:00Z'), 2)).toBeNull();
  });

  it('works for timed schedules across a clock change and in other zones', () => {
    const timedBins: FixedSchedule = { ...bins, start: timed('2026-10-15T07:00:00Z') };
    const dues = expand(timedBins, {
      from: at('2026-10-15T00:00:00Z'),
      to: at('2026-11-20T00:00:00Z'),
    });
    expect(dues.map((due) => alternationIndex(timedBins, due, 2))).toEqual([0, 1, 0, 1, 0, 1]);
    const newYork: FixedSchedule = { ...bins, start: timed('2026-10-15T12:00:00Z') };
    const nyDues = expand(newYork, {
      from: at('2026-10-15T00:00:00Z'),
      to: at('2026-11-20T00:00:00Z'),
      timezone: 'America/New_York',
    });
    expect(
      nyDues.map((due) => alternationIndex(newYork, due, 2, { timezone: 'America/New_York' })),
    ).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('counts occurrences, so it also works for monthly rules', () => {
    const monthly: FixedSchedule = {
      kind: 'fixed',
      rrule: rrules.monthlyOnDay(31),
      start: allDay('2026-01-01'),
    };
    // 31 Jan, 31 Mar, 31 May, 31 Jul: indices 0, 1, 0, 1 with two alternatives.
    expect(alternationIndex(monthly, allDay('2026-07-31'), 2)).toBe(1);
    expect(alternationIndex(monthly, allDay('2026-05-31'), 2)).toBe(0);
  });

  it('validates its arguments', () => {
    expect(() => alternationIndex(bins, allDay('2026-10-01'), 1)).toThrow(/alternatives/);
    expect(() => alternationIndex(bins, allDay('2026-10-01'), 2.5)).toThrow(/alternatives/);
    expect(() => alternationIndex(bins, allDay('2026-10-01'), 2, { timezone: 'x/y' })).toThrow(
      /time zone/,
    );
    expect(() =>
      alternationIndex({ ...bins, rrule: 'FREQ=HOURLY' }, allDay('2026-10-01'), 2),
    ).toThrow(/FREQ/);
  });
});
