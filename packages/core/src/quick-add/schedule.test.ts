import { describe, expect, it } from 'vitest';
import { rrules } from '../recurrence/builders.js';
import { anchoredRule, anchorTemplateRule, buildSchedule } from './schedule.js';
import { NOW, TODAY, TZ } from './test-util.js';

const build = (request: Parameters<typeof buildSchedule>[0], now = NOW) =>
  buildSchedule(request, now, TZ);

describe('anchoredRule', () => {
  it('anchors every-N-units rules on the date, with the builders', () => {
    expect(anchoredRule('day', 3, '2026-11-01')).toBe(rrules.daily(3));
    expect(anchoredRule('week', 2, '2026-11-01')).toBe(rrules.weekly(['SU'], 2));
    expect(anchoredRule('week', 1, '2026-10-17')).toBe(rrules.weekly(['SA']));
    expect(anchoredRule('month', 1, '2026-11-15')).toBe(rrules.monthlyOnDay(15));
    expect(anchoredRule('year', 1, '2026-11-01')).toBe(rrules.yearly(11, 1));
    expect(anchoredRule('year', 10, '2028-02-29')).toBe(rrules.yearly(2, 29, 10));
  });
});

describe('anchoredRule on the last days of a month', () => {
  it('keeps a monthly day up to the 30th when it is not the last day of its month', () => {
    expect(anchoredRule('month', 1, '2027-01-29', false)).toBe(rrules.monthlyOnDay(29));
    expect(anchoredRule('month', 1, '2027-01-30', false)).toBe(rrules.monthlyOnDay(30));
    expect(anchoredRule('month', 1, '2027-02-28', false)).toBe(rrules.monthlyOnDay(28));
  });

  it('means the last day when an unnamed day is the last of a 29, 30 or 31 day month', () => {
    expect(anchoredRule('month', 1, '2027-01-31', false)).toBe(rrules.monthlyOnDay(-1));
    expect(anchoredRule('month', 2, '2027-04-30', false)).toBe(rrules.monthlyOnDay(-1, 2));
    expect(anchoredRule('month', 1, '2028-02-29', false)).toBe(rrules.monthlyOnDay(-1));
  });

  it('keeps a day the text named', () => {
    expect(anchoredRule('month', 1, '2027-01-31')).toBe(rrules.monthlyOnDay(31));
    expect(anchoredRule('month', 1, '2027-04-30', true)).toBe(rrules.monthlyOnDay(30));
  });

  it('leaves a yearly 29 Feb as the leap day', () => {
    expect(anchoredRule('year', 1, '2028-02-29', false)).toBe(rrules.yearly(2, 29));
  });
});

describe('anchorTemplateRule', () => {
  it('turns a bare frequency into a rule for the due date', () => {
    expect(anchorTemplateRule('FREQ=YEARLY', '2027-03-14')).toBe(rrules.yearly(3, 14));
    expect(anchorTemplateRule('FREQ=YEARLY;INTERVAL=10', '2029-09-09')).toBe(
      rrules.yearly(9, 9, 10),
    );
    expect(anchorTemplateRule('FREQ=MONTHLY', '2026-10-17')).toBe(rrules.monthlyOnDay(17));
    expect(anchorTemplateRule('FREQ=WEEKLY;INTERVAL=2', '2026-10-21')).toBe(
      rrules.weekly(['WE'], 2),
    );
    expect(anchorTemplateRule('FREQ=DAILY', '2026-10-21')).toBe(rrules.daily());
  });

  it('rewrites a fixed calendar date with the builder and keeps anything more specific', () => {
    expect(anchorTemplateRule('FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=31', '2027-01-20')).toBe(
      rrules.yearly(1, 31),
    );
    const clocks = 'FREQ=YEARLY;BYMONTH=3,10;BYDAY=-1SU';
    expect(anchorTemplateRule(clocks, '2026-10-25')).toBe(clocks);
  });
});

describe('buildSchedule', () => {
  it('is undated with nothing to go on', () => {
    expect(build({})).toEqual({ scheduleKind: 'once', allDay: true });
  });

  it('makes a one-off all-day task from a date', () => {
    expect(build({ date: '2026-11-01' })).toEqual({
      scheduleKind: 'once',
      allDay: true,
      dueDate: '2026-11-01',
    });
  });

  it('makes a timed task from a date and time, in the household zone', () => {
    // BST: 09:00 London is 08:00 UTC. GMT after 25 October: the same.
    expect(build({ date: '2026-10-24', time: '09:00' })).toEqual({
      scheduleKind: 'once',
      allDay: false,
      dueAt: '2026-10-24T08:00:00.000Z',
    });
    expect(build({ date: '2026-10-26', time: '09:00' })).toMatchObject({
      dueAt: '2026-10-26T09:00:00.000Z',
    });
  });

  it('uses the day a lone time next falls on', () => {
    expect(build({ time: '17:00', impliedDate: '2026-10-18' })).toEqual({
      scheduleKind: 'once',
      allDay: false,
      dueAt: '2026-10-18T16:00:00.000Z',
    });
  });

  it('starts a rule on its first match on or after the date', () => {
    // 1 Nov 2026 is a Sunday; the rule wants Tuesdays.
    expect(
      build({
        date: '2026-11-01',
        pattern: { kind: 'rrule', rrule: rrules.weekly(['TU']) },
      }),
    ).toEqual({
      scheduleKind: 'fixed',
      rrule: rrules.weekly(['TU']),
      allDay: true,
      dueDate: '2026-11-03',
    });
  });

  it('starts a rule with no date on its first match from now', () => {
    expect(build({ pattern: { kind: 'rrule', rrule: rrules.weekly(['TU']) } })).toMatchObject({
      dueDate: '2026-10-20',
    });
    // Saturday today, and the rule wants Saturdays: today counts.
    expect(build({ pattern: { kind: 'interval', unit: 'week', interval: 1 } })).toMatchObject({
      rrule: rrules.weekly(['SA']),
      dueDate: TODAY,
    });
  });

  it('repeats "every month" typed on the 31st on the last day of each month', () => {
    const month = { kind: 'interval', unit: 'month', interval: 1 } as const;
    const thirtyFirst = new Date('2027-01-31T12:00:00Z');
    expect(build({ pattern: month }, thirtyFirst)).toMatchObject({
      rrule: rrules.monthlyOnDay(-1),
      dueDate: '2027-01-31',
    });
    // The 30th is the last day of April but not of January.
    expect(build({ pattern: month }, new Date('2027-04-30T12:00:00Z'))).toMatchObject({
      rrule: rrules.monthlyOnDay(-1),
    });
    expect(build({ pattern: month }, new Date('2027-01-30T12:00:00Z'))).toMatchObject({
      rrule: rrules.monthlyOnDay(30),
    });
    expect(build({ pattern: month }, new Date('2027-01-29T12:00:00Z'))).toMatchObject({
      rrule: rrules.monthlyOnDay(29),
    });
  });

  it('keeps the 31st when a date named it', () => {
    expect(
      build({ date: '2027-01-31', pattern: { kind: 'interval', unit: 'month', interval: 1 } }),
    ).toMatchObject({ rrule: rrules.monthlyOnDay(31), dueDate: '2027-01-31' });
  });

  it('repeats an interval rule on the date it names', () => {
    expect(
      build({ date: '2026-11-01', pattern: { kind: 'interval', unit: 'year', interval: 1 } }),
    ).toEqual({
      scheduleKind: 'fixed',
      rrule: rrules.yearly(11, 1),
      allDay: true,
      dueDate: '2026-11-01',
    });
  });

  it('skips a time already passed today when there is no date', () => {
    const daily = { kind: 'interval', unit: 'day', interval: 1 } as const;
    expect(build({ pattern: daily, time: '07:30' })).toMatchObject({
      allDay: false,
      dueAt: '2026-10-18T06:30:00.000Z',
    });
    expect(build({ pattern: daily, time: '18:00' })).toMatchObject({
      dueAt: '2026-10-17T17:00:00.000Z',
    });
  });

  it('keeps a stated first date even when it is in the past', () => {
    const daily = { kind: 'interval', unit: 'day', interval: 1 } as const;
    expect(build({ date: '2026-10-01', pattern: daily })).toMatchObject({ dueDate: '2026-10-01' });
  });

  it('schedules after completion from the date, or today', () => {
    const after = { kind: 'after_completion', days: 42 } as const;
    expect(build({ pattern: after })).toEqual({
      scheduleKind: 'after_completion',
      intervalAfterCompletionDays: 42,
      allDay: true,
      dueDate: TODAY,
    });
    expect(build({ date: '2026-11-01', time: '10:00', pattern: after })).toEqual({
      scheduleKind: 'after_completion',
      intervalAfterCompletionDays: 42,
      allDay: false,
      dueAt: '2026-11-01T10:00:00.000Z',
    });
  });
});
