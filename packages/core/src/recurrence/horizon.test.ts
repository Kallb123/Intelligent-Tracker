import { describe, expect, it } from 'vitest';
import { rrules } from './builders.js';
import { RecurrenceError } from './errors.js';
import {
  HORIZON_PADDING_DAYS,
  materialisationHorizonDays,
  MIN_HORIZON_DAYS,
  occurrencesToMaterialise,
  startAtFor,
} from './horizon.js';
import { allDay, at, show, timed } from './test-util.js';
import type { FixedSchedule, Schedule } from './types.js';

const dues = (list: { due: Parameters<typeof show>[0][number] }[]) =>
  show(list.map((entry) => entry.due));

describe('materialisationHorizonDays', () => {
  it('is max(90, lead + 30)', () => {
    expect(MIN_HORIZON_DAYS).toBe(90);
    expect(HORIZON_PADDING_DAYS).toBe(30);
    expect(materialisationHorizonDays(null)).toBe(90);
    expect(materialisationHorizonDays(0)).toBe(90);
    expect(materialisationHorizonDays(30)).toBe(90);
    expect(materialisationHorizonDays(60)).toBe(90);
    expect(materialisationHorizonDays(61)).toBe(91);
    expect(materialisationHorizonDays(100)).toBe(130);
  });

  it('rejects negative, fractional or absurd lead times', () => {
    for (const bad of [-1, 1.5, 3651, Number.NaN]) {
      expect(() => materialisationHorizonDays(bad)).toThrow(RecurrenceError);
    }
  });
});

describe('startAtFor', () => {
  it('is local midnight of the start date for all-day dues (1 Nov, 30 days -> 2 Oct, BST)', () => {
    expect(startAtFor(allDay('2026-11-01'), 30)?.toISOString()).toBe('2026-10-01T23:00:00.000Z');
  });

  it('keeps the wall-clock time for timed dues, across the clock change', () => {
    // 19:00 GMT on 28 Oct minus 7 days is 19:00 BST on 21 Oct.
    expect(startAtFor(timed('2026-10-28T19:00:00Z'), 7)?.toISOString()).toBe(
      '2026-10-21T18:00:00.000Z',
    );
    expect(startAtFor(timed('2026-10-28T19:00:00Z'), 0)?.toISOString()).toBe(
      '2026-10-28T19:00:00.000Z',
    );
  });

  it('is null without a lead time and validates its input', () => {
    expect(startAtFor(allDay('2026-11-01'), null)).toBeNull();
    expect(() => startAtFor(allDay('2026-11-01'), -1)).toThrow(RecurrenceError);
    expect(() => startAtFor(allDay('2026-02-30'), 1)).toThrow(RecurrenceError);
    expect(() => startAtFor(allDay('2026-11-01'), 1, { timezone: 'x/y' })).toThrow(RecurrenceError);
  });

  it('respects the zone', () => {
    expect(
      startAtFor(allDay('2026-11-01'), 30, { timezone: 'America/New_York' })?.toISOString(),
    ).toBe('2026-10-02T04:00:00.000Z');
  });
});

describe('occurrencesToMaterialise', () => {
  const now = at('2026-10-10T09:00:00Z');

  it('covers from the start of today to the horizon for a daily task', () => {
    const schedule: FixedSchedule = {
      kind: 'fixed',
      rrule: rrules.daily(),
      start: allDay('2026-01-01'),
    };
    const result = occurrencesToMaterialise(schedule, { now, leadTimeDays: null });
    expect(result).toHaveLength(91); // today plus 90 days
    expect(result[0]).toEqual({ due: allDay('2026-10-10'), startAt: null });
    expect(result.at(-1)?.due).toEqual(allDay('2027-01-08'));
  });

  it('widens the horizon with the lead time (lead 60 -> 90 days, lead 100 -> 130 days)', () => {
    const schedule: FixedSchedule = {
      kind: 'fixed',
      rrule: rrules.daily(),
      start: allDay('2026-01-01'),
    };
    expect(occurrencesToMaterialise(schedule, { now, leadTimeDays: 60 })).toHaveLength(91);
    const long = occurrencesToMaterialise(schedule, { now, leadTimeDays: 100 });
    expect(long).toHaveLength(131);
    expect(long.at(-1)?.due).toEqual(allDay('2027-02-17'));
  });

  it('includes dues that are today but earlier than now, and excludes yesterday', () => {
    const schedule: FixedSchedule = {
      kind: 'fixed',
      rrule: rrules.daily(),
      start: timed('2026-10-01T07:00:00Z'),
    };
    const result = occurrencesToMaterialise(schedule, { now, leadTimeDays: null });
    expect(dues(result)[0]).toBe('2026-10-10T07:00:00.000Z');
  });

  it('always yields the next occurrence of a yearly task, however far away', () => {
    const insurance: FixedSchedule = {
      kind: 'fixed',
      rrule: rrules.yearly(11, 1),
      start: allDay('2024-11-01'),
    };
    // Within the horizon: 1 Nov is 22 days away.
    expect(occurrencesToMaterialise(insurance, { now, leadTimeDays: 30 })).toEqual([
      { due: allDay('2026-11-01'), startAt: at('2026-10-01T23:00:00Z') },
    ]);
    // Far outside it: from 1 April the next one is 7 months out, beyond 90 days.
    expect(
      occurrencesToMaterialise(insurance, { now: at('2026-04-01T12:00:00Z'), leadTimeDays: 30 }),
    ).toEqual([{ due: allDay('2026-11-01'), startAt: at('2026-10-01T23:00:00Z') }]);
    expect(
      occurrencesToMaterialise(insurance, { now: at('2026-11-02T12:00:00Z'), leadTimeDays: null }),
    ).toEqual([{ due: allDay('2027-11-01'), startAt: null }]);
  });

  it('returns nothing for a finished fixed schedule', () => {
    const schedule: FixedSchedule = {
      kind: 'fixed',
      rrule: 'FREQ=DAILY;COUNT=3',
      start: allDay('2026-01-01'),
    };
    expect(occurrencesToMaterialise(schedule, { now, leadTimeDays: null })).toEqual([]);
  });

  it('is deterministic and idempotent', () => {
    const schedule: FixedSchedule = {
      kind: 'fixed',
      rrule: rrules.weekly(['MO', 'FR']),
      start: timed('2026-01-05T19:00:00Z'),
    };
    const options = { now, leadTimeDays: 14 };
    expect(occurrencesToMaterialise(schedule, options)).toEqual(
      occurrencesToMaterialise(schedule, { ...options }),
    );
    // Calling again a few hours later the same day gives the same dues.
    expect(
      occurrencesToMaterialise(schedule, { now: at('2026-10-10T20:00:00Z'), leadTimeDays: 14 }),
    ).toEqual(occurrencesToMaterialise(schedule, options));
  });

  it('computes startAt in local time for timed dues', () => {
    const schedule: FixedSchedule = {
      kind: 'fixed',
      rrule: rrules.weekly(['WE']),
      start: timed('2026-10-14T18:00:00Z'), // 19:00 BST
    };
    const result = occurrencesToMaterialise(schedule, { now, leadTimeDays: 3 });
    expect(result[0]).toEqual({
      due: timed('2026-10-14T18:00:00Z'),
      startAt: at('2026-10-11T18:00:00Z'),
    });
    // 28 Oct is after the clocks went back: due 19:00 GMT, start 25 Oct 19:00 GMT.
    expect(
      result.find((entry) => dues([entry])[0] === '2026-10-28T19:00:00.000Z')?.startAt,
    ).toEqual(at('2026-10-25T19:00:00Z'));
  });

  it('works in another time zone', () => {
    const schedule: FixedSchedule = {
      kind: 'fixed',
      rrule: rrules.daily(),
      start: allDay('2026-01-01'),
    };
    // 02:00Z on 10 Oct is still 9 Oct in New York.
    const result = occurrencesToMaterialise(schedule, {
      now: at('2026-10-10T02:00:00Z'),
      leadTimeDays: null,
      timezone: 'America/New_York',
    });
    expect(result[0]?.due).toEqual(allDay('2026-10-09'));
  });

  it('returns a one-off due as is (past ones too) and nothing for an undated task', () => {
    const onceFuture: Schedule = { kind: 'once', due: allDay('2028-05-05') };
    expect(occurrencesToMaterialise(onceFuture, { now, leadTimeDays: 10 })).toEqual([
      { due: allDay('2028-05-05'), startAt: at('2028-04-24T23:00:00Z') },
    ]);
    const oncePast: Schedule = { kind: 'once', due: allDay('2026-01-01') };
    expect(dues(occurrencesToMaterialise(oncePast, { now, leadTimeDays: null }))).toEqual([
      '2026-01-01',
    ]);
    expect(
      occurrencesToMaterialise({ kind: 'once', due: null }, { now, leadTimeDays: null }),
    ).toEqual([]);
  });

  it('handles after_completion: the start when never completed, else completion + interval', () => {
    const schedule: Schedule = {
      kind: 'after_completion',
      intervalDays: 42,
      start: allDay('2026-10-20'),
    };
    expect(occurrencesToMaterialise(schedule, { now, leadTimeDays: 7 })).toEqual([
      { due: allDay('2026-10-20'), startAt: at('2026-10-12T23:00:00Z') },
    ]);
    // Completed 10 days late: the next one is 42 days after completion, not after the due date.
    const completed = occurrencesToMaterialise(schedule, {
      now,
      leadTimeDays: null,
      lastCompleted: { completedAt: at('2026-10-30T10:00:00Z'), due: allDay('2026-10-20') },
    });
    expect(dues(completed)).toEqual(['2026-12-11']);
    expect(
      occurrencesToMaterialise(schedule, {
        now,
        leadTimeDays: null,
        lastCompleted: undefined,
      }),
    ).toEqual([{ due: allDay('2026-10-20'), startAt: null }]);
  });

  it('validates its input', () => {
    const schedule: Schedule = { kind: 'once', due: null };
    expect(() =>
      occurrencesToMaterialise(schedule, { now: new Date('x'), leadTimeDays: null }),
    ).toThrow(RecurrenceError);
    expect(() => occurrencesToMaterialise(schedule, { now, leadTimeDays: -5 })).toThrow(
      RecurrenceError,
    );
    expect(() =>
      occurrencesToMaterialise(
        { kind: 'fixed', rrule: 'x', start: allDay('2026-01-01') },
        { now, leadTimeDays: null },
      ),
    ).toThrow(RecurrenceError);
    expect(() =>
      occurrencesToMaterialise(
        { kind: 'fixed', rrule: rrules.daily(), start: allDay('2026-01-01') },
        { now, leadTimeDays: null, timezone: 'x/y' },
      ),
    ).toThrow(RecurrenceError);
  });
});
