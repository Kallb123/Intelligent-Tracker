import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPAND_LIMIT, expand, nextOccurrence, previewDates } from './expand.js';
import { RecurrenceError } from './errors.js';
import { rrules } from './builders.js';
import { allDay, at, localParts, show, timed } from './test-util.js';
import type { Due, FixedSchedule, Schedule } from './types.js';

const fixed = (rrule: string, start: Due): FixedSchedule => ({ kind: 'fixed', rrule, start });
const range = (from: string, to: string) => ({ from: at(from), to: at(to) });

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof RecurrenceError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('daily timed rules across BST/GMT changes (Europe/London)', () => {
  it('keeps 08:00 local across the spring change (2026-03-29)', () => {
    const schedule = fixed('FREQ=DAILY', timed('2026-03-27T08:00:00Z'));
    expect(show(expand(schedule, range('2026-03-27T00:00:00Z', '2026-03-31T12:00:00Z')))).toEqual([
      '2026-03-27T08:00:00.000Z', // GMT
      '2026-03-28T08:00:00.000Z',
      '2026-03-29T07:00:00.000Z', // BST from here on
      '2026-03-30T07:00:00.000Z',
      '2026-03-31T07:00:00.000Z',
    ]);
  });

  it('keeps 08:00 local across the autumn change (2026-10-25)', () => {
    const schedule = fixed('FREQ=DAILY', timed('2026-10-23T07:00:00Z')); // 08:00 BST
    expect(show(expand(schedule, range('2026-10-23T00:00:00Z', '2026-10-27T12:00:00Z')))).toEqual([
      '2026-10-23T07:00:00.000Z', // BST
      '2026-10-24T07:00:00.000Z',
      '2026-10-25T08:00:00.000Z', // GMT from here on
      '2026-10-26T08:00:00.000Z',
      '2026-10-27T08:00:00.000Z',
    ]);
  });

  it('moves 01:30 forward to 02:30 BST on the spring-forward day, then back to 01:30 GMT/BST', () => {
    const schedule = fixed('FREQ=DAILY', timed('2026-03-27T01:30:00Z'));
    const dues = expand(schedule, range('2026-03-27T00:00:00Z', '2026-03-31T12:00:00Z'));
    expect(show(dues)).toEqual([
      '2026-03-27T01:30:00.000Z',
      '2026-03-28T01:30:00.000Z',
      '2026-03-29T01:30:00.000Z', // 01:30 does not exist: this instant is 02:30 BST
      '2026-03-30T00:30:00.000Z', // 01:30 BST
      '2026-03-31T00:30:00.000Z',
    ]);
    expect(dues.map((due) => (due.allDay ? '' : localParts(due.at, 'Europe/London').time))).toEqual(
      ['01:30', '01:30', '02:30', '01:30', '01:30'],
    );
  });

  it('uses the first (BST) 01:30 on the autumn-overlap day, and the next day is unaffected', () => {
    const schedule = fixed('FREQ=DAILY', timed('2026-10-23T00:30:00Z')); // 01:30 BST
    const dues = expand(schedule, range('2026-10-23T00:00:00Z', '2026-10-27T12:00:00Z'));
    expect(show(dues)).toEqual([
      '2026-10-23T00:30:00.000Z',
      '2026-10-24T00:30:00.000Z',
      '2026-10-25T00:30:00.000Z', // the earlier 01:30 (BST), not 01:30 GMT (01:30Z)
      '2026-10-26T01:30:00.000Z', // 01:30 GMT
      '2026-10-27T01:30:00.000Z',
    ]);
  });

  it('runs weekly Monday 19:00 through both changes', () => {
    const schedule = fixed(rrules.weekly(['MO']), timed('2026-03-23T19:00:00Z'));
    const dues = expand(schedule, range('2026-03-20T00:00:00Z', '2026-11-03T00:00:00Z'));
    expect(dues.length).toBe(33);
    for (const due of dues) {
      if (due.allDay) throw new Error('expected timed dues');
      expect(localParts(due.at, 'Europe/London').time).toBe('19:00');
    }
    expect(show(dues).slice(0, 2)).toEqual([
      '2026-03-23T19:00:00.000Z',
      '2026-03-30T18:00:00.000Z',
    ]);
    expect(show(dues).slice(-2)).toEqual(['2026-10-26T19:00:00.000Z', '2026-11-02T19:00:00.000Z']);
  });

  it('is not hard-coded to London (America/New_York keeps 08:00 local across its own changes)', () => {
    // 08:00 EST = 13:00Z; US clocks went forward on 2026-03-08.
    const schedule = fixed('FREQ=DAILY', timed('2026-03-06T13:00:00Z'));
    const dues = expand(schedule, {
      ...range('2026-03-06T00:00:00Z', '2026-03-10T23:00:00Z'),
      timezone: 'America/New_York',
    });
    expect(show(dues)).toEqual([
      '2026-03-06T13:00:00.000Z',
      '2026-03-07T13:00:00.000Z',
      '2026-03-08T12:00:00.000Z',
      '2026-03-09T12:00:00.000Z',
      '2026-03-10T12:00:00.000Z',
    ]);
  });
});

describe('fortnightly and alternating weeks', () => {
  it('repeats every other week from the start week', () => {
    const schedule = fixed(rrules.weekly(['TH'], 2), timed('2026-10-01T17:00:00Z')); // 18:00 BST
    expect(show(expand(schedule, range('2026-09-01T00:00:00Z', '2026-11-30T00:00:00Z')))).toEqual([
      '2026-10-01T17:00:00.000Z',
      '2026-10-15T17:00:00.000Z',
      '2026-10-29T18:00:00.000Z',
      '2026-11-12T18:00:00.000Z', // GMT: 18:00 local = 18:00Z
      '2026-11-26T18:00:00.000Z',
    ]);
  });

  it('only counts the start as a due when it matches the rule', () => {
    // 2026-10-07 is a Wednesday, so the first Thursday is the 8th.
    const schedule = fixed(rrules.weekly(['TH']), allDay('2026-10-07'));
    expect(show(expand(schedule, range('2026-10-01T12:00:00Z', '2026-10-20T12:00:00Z')))).toEqual([
      '2026-10-08',
      '2026-10-15',
    ]);
  });
});

describe('month ends', () => {
  it('skips months without a 31st for BYMONTHDAY=31 and for a monthly rule starting on the 31st', () => {
    const expected = [
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
      '2026-08-31',
      '2026-10-31',
      '2026-12-31',
    ];
    const window = range('2026-01-01T12:00:00Z', '2026-12-31T12:00:00Z');
    expect(show(expand(fixed(rrules.monthlyOnDay(31), allDay('2026-01-01')), window))).toEqual(
      expected,
    );
    expect(show(expand(fixed('FREQ=MONTHLY', allDay('2026-01-31')), window))).toEqual(expected);
  });

  it('finds the last day of every month with BYMONTHDAY=-1, including February in leap and common years', () => {
    const schedule = fixed(rrules.monthlyOnDay(-1), allDay('2027-12-01'));
    const dues = show(expand(schedule, range('2027-12-01T12:00:00Z', '2028-04-01T12:00:00Z')));
    expect(dues).toEqual(['2027-12-31', '2028-01-31', '2028-02-29', '2028-03-31']);
    const common = fixed(rrules.monthlyOnDay(-1), allDay('2027-01-01'));
    expect(show(expand(common, range('2027-02-01T12:00:00Z', '2027-02-28T12:00:00Z')))).toEqual([
      '2027-02-28',
    ]);
  });

  it('fires yearly on 29 February only in leap years', () => {
    const schedule = fixed('FREQ=YEARLY', allDay('2024-02-29'));
    expect(show(previewDates(schedule, at('2024-01-01T00:00:00Z'), 4))).toEqual([
      '2024-02-29',
      '2028-02-29',
      '2032-02-29',
      '2036-02-29',
    ]);
    expect(show(expand(schedule, range('2025-01-01T00:00:00Z', '2027-12-31T00:00:00Z')))).toEqual(
      [],
    );
  });

  it('finds the last Friday of the month', () => {
    const schedule = fixed(rrules.monthlyOnNthWeekday(-1, 'FR'), allDay('2026-01-01'));
    expect(show(expand(schedule, range('2026-09-01T12:00:00Z', '2026-12-31T12:00:00Z')))).toEqual([
      '2026-09-25',
      '2026-10-30',
      '2026-11-27',
      '2026-12-25',
    ]);
  });

  it('handles the yearly car-insurance renewal on 1 November', () => {
    const schedule = fixed(rrules.yearly(11, 1), allDay('2025-11-01'));
    expect(show(expand(schedule, range('2026-01-01T12:00:00Z', '2028-12-31T12:00:00Z')))).toEqual([
      '2026-11-01',
      '2027-11-01',
      '2028-11-01',
    ]);
  });
});

describe('range semantics', () => {
  const daily = fixed('FREQ=DAILY', allDay('2026-07-01'));

  it('includes both ends for timed dues', () => {
    const schedule = fixed('FREQ=DAILY', timed('2026-07-01T07:00:00Z'));
    const dues = expand(schedule, range('2026-07-02T07:00:00Z', '2026-07-04T07:00:00Z'));
    expect(show(dues)).toEqual([
      '2026-07-02T07:00:00.000Z',
      '2026-07-03T07:00:00.000Z',
      '2026-07-04T07:00:00.000Z',
    ]);
    const justInside = expand(schedule, range('2026-07-02T07:00:00.001Z', '2026-07-03T06:59:59Z'));
    expect(justInside).toEqual([]);
  });

  it('compares all-day dues with the local dates of from and to', () => {
    // 23:30Z on 1 July is 00:30 on 2 July in London, so 2 July is the first day in range.
    const dues = expand(daily, range('2026-07-01T23:30:00Z', '2026-07-03T22:59:00Z'));
    expect(show(dues)).toEqual(['2026-07-02', '2026-07-03']);
    // In New York the same instants are still on 1 July and 3 July.
    const newYork = expand(daily, {
      ...range('2026-07-01T23:30:00Z', '2026-07-03T22:59:00Z'),
      timezone: 'America/New_York',
    });
    expect(show(newYork)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
  });

  it('returns nothing when from is after to', () => {
    expect(expand(daily, range('2026-07-10T00:00:00Z', '2026-07-01T00:00:00Z'))).toEqual([]);
  });

  it('returns nothing before the start', () => {
    expect(expand(daily, range('2020-01-01T00:00:00Z', '2020-12-31T00:00:00Z'))).toEqual([]);
  });

  it('keeps the earliest dues when limit is hit, and defaults the cap to 1000', () => {
    const limited = expand(daily, {
      ...range('2026-07-01T00:00:00Z', '2026-12-31T00:00:00Z'),
      limit: 3,
    });
    expect(show(limited)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    const all = expand(daily, range('2026-07-01T00:00:00Z', '2036-12-31T00:00:00Z'));
    expect(all).toHaveLength(DEFAULT_EXPAND_LIMIT);
  });

  it('stops quickly for rules with no future matches', () => {
    // 29 Feb on a Monday, in a range of common years: nothing, and no long scan.
    const rare = fixed('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO', allDay('2026-01-01'));
    expect(expand(rare, range('2026-01-01T00:00:00Z', '2027-12-31T00:00:00Z'))).toEqual([]);
  });
});

describe('RRULE end conditions', () => {
  it('stops after COUNT dues, counted from the start', () => {
    const schedule = fixed('FREQ=DAILY;COUNT=3', allDay('2026-07-01'));
    expect(show(expand(schedule, range('2026-07-02T12:00:00Z', '2026-12-31T12:00:00Z')))).toEqual([
      '2026-07-02',
      '2026-07-03',
    ]);
  });

  it('includes the whole UNTIL day for a date UNTIL on a timed rule', () => {
    const schedule = fixed('FREQ=DAILY;UNTIL=20260703', timed('2026-07-01T20:00:00Z')); // 21:00 BST
    expect(show(expand(schedule, range('2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z')))).toEqual([
      '2026-07-01T20:00:00.000Z',
      '2026-07-02T20:00:00.000Z',
      '2026-07-03T20:00:00.000Z',
    ]);
  });

  it('treats a date-time UNTIL as an instant', () => {
    const schedule = fixed('FREQ=DAILY;UNTIL=20260703T200000Z', timed('2026-07-01T20:00:00Z'));
    expect(show(expand(schedule, range('2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z')))).toEqual([
      '2026-07-01T20:00:00.000Z',
      '2026-07-02T20:00:00.000Z',
      '2026-07-03T20:00:00.000Z',
    ]);
    const earlier = fixed('FREQ=DAILY;UNTIL=20260703T195959Z', timed('2026-07-01T20:00:00Z'));
    expect(expand(earlier, range('2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z'))).toHaveLength(2);
  });

  it('supports BYSETPOS (last weekday of the month)', () => {
    const schedule = fixed('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', allDay('2026-01-01'));
    expect(show(expand(schedule, range('2026-05-01T12:00:00Z', '2026-07-31T12:00:00Z')))).toEqual([
      '2026-05-29',
      '2026-06-30',
      '2026-07-31',
    ]);
  });
});

describe('once and after_completion schedules', () => {
  const window = range('2026-07-01T00:00:00Z', '2026-07-31T00:00:00Z');

  it('yields a one-off due only when in range', () => {
    const once: Schedule = { kind: 'once', due: allDay('2026-07-10') };
    expect(show(expand(once, window))).toEqual(['2026-07-10']);
    expect(expand({ kind: 'once', due: allDay('2026-08-10') }, window)).toEqual([]);
    expect(expand({ kind: 'once', due: null }, window)).toEqual([]);
  });

  it('yields only the start for after_completion', () => {
    const schedule: Schedule = {
      kind: 'after_completion',
      intervalDays: 7,
      start: timed('2026-07-10T08:00:00Z'),
    };
    expect(show(expand(schedule, window))).toEqual(['2026-07-10T08:00:00.000Z']);
    expect(show(previewDates(schedule, at('2026-07-01T00:00:00Z')))).toEqual([
      '2026-07-10T08:00:00.000Z',
    ]);
  });
});

describe('nextOccurrence', () => {
  it('returns the first due strictly after the instant', () => {
    const schedule = fixed('FREQ=DAILY', timed('2026-07-01T07:00:00Z'));
    expect(show([nextOccurrence(schedule, at('2026-07-05T06:59:59Z'))])).toEqual([
      '2026-07-05T07:00:00.000Z',
    ]);
    expect(show([nextOccurrence(schedule, at('2026-07-05T07:00:00Z'))])).toEqual([
      '2026-07-06T07:00:00.000Z',
    ]);
  });

  it('is day-granular for all-day dues', () => {
    const schedule = fixed('FREQ=DAILY', allDay('2026-07-01'));
    // 23:30Z on 5 July is already 6 July in London, so 6 July is not "after" it.
    expect(show([nextOccurrence(schedule, at('2026-07-05T23:30:00Z'))])).toEqual(['2026-07-07']);
    expect(show([nextOccurrence(schedule, at('2026-07-05T12:00:00Z'))])).toEqual(['2026-07-06']);
    expect(
      show([
        nextOccurrence(schedule, at('2026-07-05T23:30:00Z'), { timezone: 'America/New_York' }),
      ]),
    ).toEqual(['2026-07-06']);
  });

  it('returns null when the schedule is exhausted or has no due', () => {
    expect(
      nextOccurrence(fixed('FREQ=DAILY;COUNT=2', allDay('2026-07-01')), at('2026-07-02T12:00:00Z')),
    ).toBeNull();
    expect(nextOccurrence({ kind: 'once', due: null }, at('2026-07-02T12:00:00Z'))).toBeNull();
    expect(
      nextOccurrence({ kind: 'once', due: allDay('2026-07-01') }, at('2026-07-02T12:00:00Z')),
    ).toBeNull();
    expect(
      show([
        nextOccurrence({ kind: 'once', due: allDay('2026-07-05') }, at('2026-07-02T12:00:00Z')),
      ]),
    ).toEqual(['2026-07-05']);
  });

  it('finds a due years away without a range', () => {
    const schedule = fixed('FREQ=YEARLY', allDay('2024-02-29'));
    expect(show([nextOccurrence(schedule, at('2024-03-01T00:00:00Z'))])).toEqual(['2028-02-29']);
  });
});

describe('previewDates', () => {
  it('lists the next five dates by default, from an inclusive start', () => {
    const schedule = fixed(rrules.weekly(['MO', 'FR']), allDay('2026-10-01'));
    expect(show(previewDates(schedule, at('2026-10-09T12:00:00Z')))).toEqual([
      '2026-10-09',
      '2026-10-12',
      '2026-10-16',
      '2026-10-19',
      '2026-10-23',
    ]);
    expect(previewDates(schedule, at('2026-10-09T12:00:00Z'), 2)).toHaveLength(2);
  });

  it('stops early when the schedule has fewer dates left', () => {
    const schedule = fixed('FREQ=DAILY;COUNT=2', allDay('2026-07-01'));
    expect(show(previewDates(schedule, at('2026-07-01T12:00:00Z'), 5))).toEqual([
      '2026-07-01',
      '2026-07-02',
    ]);
  });
});

describe('validation', () => {
  const schedule = fixed('FREQ=DAILY', allDay('2026-07-01'));
  const window = range('2026-07-01T00:00:00Z', '2026-07-10T00:00:00Z');

  it('rejects bad options with typed errors', () => {
    expect(codeOf(() => expand(schedule, { ...window, timezone: 'Nowhere/Land' }))).toBe(
      'invalid_timezone',
    );
    expect(codeOf(() => expand(schedule, { ...window, from: new Date('x') }))).toBe('invalid_date');
    expect(codeOf(() => expand(schedule, { ...window, to: new Date('x') }))).toBe('invalid_date');
    expect(codeOf(() => expand(schedule, { ...window, limit: 0 }))).toBe('invalid_argument');
    expect(codeOf(() => expand(schedule, { ...window, limit: 1.5 }))).toBe('invalid_argument');
    expect(codeOf(() => nextOccurrence(schedule, new Date('x')))).toBe('invalid_date');
    expect(
      codeOf(() => nextOccurrence(schedule, at('2026-07-01T00:00:00Z'), { timezone: 'x/y' })),
    ).toBe('invalid_timezone');
    expect(codeOf(() => previewDates(schedule, new Date('x')))).toBe('invalid_date');
    expect(codeOf(() => previewDates(schedule, at('2026-07-01T00:00:00Z'), 0))).toBe(
      'invalid_argument',
    );
  });

  it('rejects bad schedules before expanding', () => {
    expect(codeOf(() => expand(fixed('FREQ=HOURLY', allDay('2026-07-01')), window))).toBe(
      'unsupported_rrule',
    );
    expect(codeOf(() => expand(fixed('nonsense', allDay('2026-07-01')), window))).toBe(
      'invalid_rrule',
    );
    expect(codeOf(() => expand(fixed('FREQ=DAILY', allDay('2026-02-30')), window))).toBe(
      'invalid_date',
    );
  });
});
