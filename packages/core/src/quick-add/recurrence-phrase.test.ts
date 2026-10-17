import { describe, expect, it } from 'vitest';
import { rrules } from '../recurrence/builders.js';
import { findRecurrence, type RecurrencePattern } from './recurrence-phrase.js';

const rule = (rrule: string): RecurrencePattern => ({ kind: 'rrule', rrule });
const every = (unit: 'day' | 'week' | 'month' | 'year', interval = 1): RecurrencePattern => ({
  kind: 'interval',
  unit,
  interval,
});

describe('findRecurrence', () => {
  it.each<[string, string, RecurrencePattern]>([
    ['every day', 'every day', every('day')],
    ['bins every week please', 'every week', every('week')],
    ['every fortnight', 'every fortnight', every('week', 2)],
    ['every month', 'every month', every('month')],
    ['every year', 'every year', every('year')],
    ['each year', 'each year', every('year')],
    ['every 3 days', 'every 3 days', every('day', 3)],
    ['every 6 weeks', 'every 6 weeks', every('week', 6)],
    ['every two months', 'every two months', every('month', 2)],
    ['every 5 years', 'every 5 years', every('year', 5)],
    ['every other week', 'every other week', every('week', 2)],
    ['every second month', 'every second month', every('month', 2)],
    ['daily', 'daily', every('day')],
    ['Weekly shop', 'Weekly', every('week')],
    ['fortnightly', 'fortnightly', every('week', 2)],
    ['monthly', 'monthly', every('month')],
    ['yearly', 'yearly', every('year')],
    ['annually', 'annually', every('year')],
    ['once a week', 'once a week', every('week')],
    ['once a year', 'once a year', every('year')],
  ])('reads %j as an interval', (text, phrase, pattern) => {
    const found = findRecurrence(text);
    expect(found?.pattern).toEqual(pattern);
    expect(text.slice(found?.start, found?.end)).toBe(phrase);
  });

  it.each<[string, string, string]>([
    ['every Tuesday', 'every Tuesday', rrules.weekly(['TU'])],
    ['each friday', 'each friday', rrules.weekly(['FR'])],
    ['every Mon', 'every Mon', rrules.weekly(['MO'])],
    ['every Monday and Thursday', 'every Monday and Thursday', rrules.weekly(['MO', 'TH'])],
    ['every Mon, Wed & Fri', 'every Mon, Wed & Fri', rrules.weekly(['MO', 'WE', 'FR'])],
    ['every other Tuesday', 'every other Tuesday', rrules.weekly(['TU'], 2)],
    [
      'every second Monday and Thursday',
      'every second Monday and Thursday',
      rrules.weekly(['MO', 'TH'], 2),
    ],
    ['every 2 weeks on Tuesday', 'every 2 weeks on Tuesday', rrules.weekly(['TU'], 2)],
    [
      'every week on Monday and Thursday',
      'every week on Monday and Thursday',
      rrules.weekly(['MO', 'TH']),
    ],
    ['weekly on Fridays', 'weekly on Fridays', rrules.weekly(['FR'])],
    ['on Tuesdays', 'on Tuesdays', rrules.weekly(['TU'])],
    ['Sundays', 'Sundays', rrules.weekly(['SU'])],
    ['on weekdays', 'on weekdays', rrules.weekly(['MO', 'TU', 'WE', 'TH', 'FR'])],
    ['every weekday', 'every weekday', rrules.weekly(['MO', 'TU', 'WE', 'TH', 'FR'])],
    ['Monday to Friday', 'Monday to Friday', rrules.weekly(['MO', 'TU', 'WE', 'TH', 'FR'])],
    ['every weekend', 'every weekend', rrules.weekly(['SA', 'SU'])],
    ['last Friday of the month', 'last Friday of the month', rrules.monthlyOnNthWeekday(-1, 'FR')],
    [
      'first Monday of every month',
      'first Monday of every month',
      rrules.monthlyOnNthWeekday(1, 'MO'),
    ],
    [
      'on the 3rd Thursday of each month',
      'on the 3rd Thursday of each month',
      rrules.monthlyOnNthWeekday(3, 'TH'),
    ],
    ['every last Friday', 'every last Friday', rrules.monthlyOnNthWeekday(-1, 'FR')],
    ['every first Monday', 'every first Monday', rrules.monthlyOnNthWeekday(1, 'MO')],
    ['last day of the month', 'last day of the month', rrules.monthlyOnDay(-1)],
    ['on the last day of every month', 'on the last day of every month', rrules.monthlyOnDay(-1)],
    ['on the 15th of every month', 'on the 15th of every month', rrules.monthlyOnDay(15)],
    ['every month on the 1st', 'every month on the 1st', rrules.monthlyOnDay(1)],
    ['monthly on the 28th', 'monthly on the 28th', rrules.monthlyOnDay(28)],
  ])('reads %j as a rule', (text, phrase, rrule) => {
    const found = findRecurrence(text);
    expect(found?.pattern).toEqual(rule(rrule));
    expect(text.slice(found?.start, found?.end).toLowerCase()).toBe(phrase.toLowerCase());
  });

  it.each<[string, string, number]>([
    ['every 6 weeks after done', 'every 6 weeks after done', 42],
    ['6 weeks after it’s done', '6 weeks after it’s done', 42],
    ["a month after it's done", "a month after it's done", 30],
    ['every 3 days after completion', 'every 3 days after completion', 3],
    ['every year once done', 'every year once done', 365],
    ['every fortnight after it is done', 'every fortnight after it is done', 14],
    ['each week after finished', 'each week after finished', 7],
  ])('reads %j as after completion', (text, phrase, days) => {
    const found = findRecurrence(text);
    expect(found?.pattern).toEqual({ kind: 'after_completion', days });
    expect(text.slice(found?.start, found?.end)).toBe(phrase);
  });

  it('prefers the longest phrase starting at the same place', () => {
    expect(findRecurrence('every 6 weeks after done')?.pattern.kind).toBe('after_completion');
    expect(findRecurrence('every week on Monday')?.pattern).toEqual(rule(rrules.weekly(['MO'])));
  });

  it('prefers the earliest phrase', () => {
    const found = findRecurrence('first Monday of every month, then every year');
    expect(found?.pattern).toEqual(rule(rrules.monthlyOnNthWeekday(1, 'MO')));
  });

  it('is not fooled by words that merely look similar', () => {
    for (const text of [
      '',
      'Buy a calendar',
      'weekday lunch',
      'once upon a time',
      'Tuesday',
      'everyday objects',
    ]) {
      expect(findRecurrence(text), text).toBeNull();
    }
  });

  it('ignores counts and days the builders refuse', () => {
    expect(findRecurrence('every 0 days')).toBeNull();
    expect(findRecurrence('every 999 fortnights')).toBeNull();
    // There is no 45th, so only "every month" is read and the rest stays in the title.
    expect(findRecurrence('on the 45th of every month')).toMatchObject({ start: 15 });
    expect(findRecurrence('every 99 years after done')?.pattern.kind).toBe('interval');
    // The refused phrase does not hide a good one.
    expect(findRecurrence('every 0 days, but every Tuesday')?.pattern).toEqual(
      rule(rrules.weekly(['TU'])),
    );
  });
});
