import { RecurrenceError } from './recurrence/errors.js';
import { describe, expect, it } from 'vitest';
import {
  buildRecurrence,
  defaultRecurrence,
  parseRecurrence,
  type RecurrenceState,
} from './recurrence-form.js';

const state = (overrides: Partial<RecurrenceState>): RecurrenceState => ({
  ...defaultRecurrence(),
  ...overrides,
});

describe('buildRecurrence', () => {
  it('stores a one-off with no rule', () => {
    expect(buildRecurrence(defaultRecurrence('once'))).toEqual({
      scheduleKind: 'once',
      rrule: null,
      intervalAfterCompletionDays: null,
    });
  });

  it('builds each pattern with the core builders', () => {
    const rule = (s: Partial<RecurrenceState>) => buildRecurrence(state(s)).rrule;

    expect(rule({ kind: 'daily', interval: 3 })).toBe('FREQ=DAILY;INTERVAL=3');
    expect(rule({ kind: 'weekly', weekdays: ['MO'] })).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO');
    // Days come out in week order whatever order they were ticked in.
    expect(rule({ kind: 'weekly', interval: 2, weekdays: ['TH', 'MO'] })).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH',
    );
    expect(rule({ kind: 'monthly', monthDay: 15 })).toBe('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15');
    expect(rule({ kind: 'monthly', lastDay: true })).toBe('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1');
    expect(
      rule({ kind: 'monthly', monthlyMode: 'weekday', nth: -1, nthWeekday: 'FR', interval: 2 }),
    ).toBe('FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR');
    expect(rule({ kind: 'yearly', month: 3, monthDay: 5 })).toBe(
      'FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=5',
    );
    expect(rule({ kind: 'custom', customRrule: '  FREQ=DAILY;COUNT=3 ' })).toBe(
      'FREQ=DAILY;COUNT=3',
    );
  });

  it('stores an after-completion interval and no rule', () => {
    expect(buildRecurrence(state({ kind: 'after_completion', afterDays: 42 }))).toEqual({
      scheduleKind: 'after_completion',
      rrule: null,
      intervalAfterCompletionDays: 42,
    });
  });

  it('explains what is missing in words', () => {
    const message = (s: Partial<RecurrenceState>) => {
      try {
        buildRecurrence(state(s));
      } catch (err) {
        expect(err).toBeInstanceOf(RecurrenceError);
        return (err as Error).message;
      }
      return undefined;
    };

    expect(message({ kind: 'weekly', weekdays: [] })).toBe('Pick at least one weekday');
    expect(message({ kind: 'daily', interval: null })).toBe(
      'The number of days must be a whole number from 1 to 999',
    );
    expect(message({ kind: 'weekly', weekdays: ['MO'], interval: 0 })).toContain('weeks');
    expect(message({ kind: 'monthly', monthDay: 32 })).toContain('day of the month');
    expect(message({ kind: 'yearly', monthDay: null })).toContain('day of the month');
    expect(message({ kind: 'custom', customRrule: '  ' })).toContain('Enter a rule');
    expect(message({ kind: 'after_completion', afterDays: 1.5 })).toContain('whole number');
  });
});

describe('parseRecurrence', () => {
  const fixed = (rrule: string) =>
    parseRecurrence({ scheduleKind: 'fixed', rrule, intervalAfterCompletionDays: null });

  it('reads one-offs and after-completion tasks', () => {
    expect(
      parseRecurrence({ scheduleKind: 'once', rrule: null, intervalAfterCompletionDays: null }),
    ).toEqual(defaultRecurrence('once'));
    expect(
      parseRecurrence({
        scheduleKind: 'after_completion',
        rrule: null,
        intervalAfterCompletionDays: 42,
      }),
    ).toMatchObject({ kind: 'after_completion', afterDays: 42 });
  });

  it('round-trips every pattern the builder writes', () => {
    const states: Partial<RecurrenceState>[] = [
      { kind: 'daily', interval: 1 },
      { kind: 'daily', interval: 10 },
      { kind: 'weekly', weekdays: ['MO'] },
      { kind: 'weekly', interval: 2, weekdays: ['MO', 'WE', 'SU'] },
      { kind: 'monthly', interval: 3, monthDay: 31 },
      { kind: 'monthly', lastDay: true },
      { kind: 'monthly', monthlyMode: 'weekday', nth: 2, nthWeekday: 'TU' },
      { kind: 'monthly', monthlyMode: 'weekday', nth: -1, nthWeekday: 'SU', interval: 2 },
      { kind: 'yearly', month: 12, monthDay: 25 },
      { kind: 'yearly', interval: 2, month: 2, lastDay: true },
    ];
    for (const s of states) {
      const original = state(s);
      const { rrule } = buildRecurrence(original);
      const parsed = fixed(rrule as string);
      expect(parsed.kind, rrule as string).toBe(original.kind);
      expect(buildRecurrence(parsed).rrule).toBe(rrule);
    }
    expect(fixed('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH')).toMatchObject({
      kind: 'weekly',
      interval: 2,
      weekdays: ['MO', 'TH'],
    });
    expect(fixed('FREQ=MONTHLY;INTERVAL=1;BYDAY=-1FR')).toMatchObject({
      kind: 'monthly',
      monthlyMode: 'weekday',
      nth: -1,
      nthWeekday: 'FR',
    });
    expect(fixed('FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=-1')).toMatchObject({
      kind: 'yearly',
      month: 3,
      lastDay: true,
    });
  });

  it('accepts an RRULE: prefix, lower case and a missing INTERVAL', () => {
    expect(fixed('RRULE:freq=weekly;byday=mo')).toMatchObject({
      kind: 'weekly',
      interval: 1,
      weekdays: ['MO'],
    });
    expect(fixed('FREQ=DAILY')).toMatchObject({ kind: 'daily', interval: 1 });
  });

  it('falls back to custom for anything the builder would not write', () => {
    for (const rule of [
      'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;COUNT=4', // an end
      'FREQ=DAILY;INTERVAL=1;UNTIL=20271231', // an end
      'FREQ=WEEKLY;INTERVAL=1;BYDAY=TH,MO', // not in week order
      'FREQ=MONTHLY;INTERVAL=1;BYDAY=MO,TU', // several weekdays of the month
      'FREQ=MONTHLY;INTERVAL=1;BYDAY=5MO', // no fifth in the builder
      'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1,15',
      'FREQ=YEARLY;INTERVAL=1;BYMONTH=3', // no day
      'FREQ=HOURLY;INTERVAL=1',
      'FREQ=WEEKLY;INTERVAL=1', // no weekday
      'FREQ=DAILY;INTERVAL=0',
      'not a rule',
      '',
    ]) {
      expect(fixed(rule), rule).toMatchObject({ kind: 'custom', customRrule: rule });
    }
  });
});
