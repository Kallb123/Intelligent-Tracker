import { describe, expect, it } from 'vitest';
import { rrules } from './builders.js';
import { RecurrenceError } from './errors.js';
import { parseRRule } from './rrule-parse.js';

describe('rrules', () => {
  it('builds the common patterns', () => {
    expect(rrules.daily()).toBe('FREQ=DAILY;INTERVAL=1');
    expect(rrules.daily(3)).toBe('FREQ=DAILY;INTERVAL=3');
    expect(rrules.weekly(['MO'])).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO');
    expect(rrules.weekly(['MO'], 2)).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO');
    // Days are de-duplicated and put in week order.
    expect(rrules.weekly(['SU', 'MO', 'MO', 'WE'])).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,SU');
    expect(rrules.monthlyOnDay(15)).toBe('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15');
    expect(rrules.monthlyOnDay(-1, 3)).toBe('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=-1');
    expect(rrules.monthlyOnNthWeekday(2, 'TU')).toBe('FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU');
    expect(rrules.monthlyOnNthWeekday(-1, 'FR', 2)).toBe('FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR');
    expect(rrules.yearly(11, 1)).toBe('FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYMONTHDAY=1');
    expect(rrules.yearly(2, -1, 2)).toBe('FREQ=YEARLY;INTERVAL=2;BYMONTH=2;BYMONTHDAY=-1');
  });

  it('only builds rules the parser accepts', () => {
    for (const rule of [
      rrules.daily(2),
      rrules.weekly(['MO', 'TH'], 2),
      rrules.monthlyOnDay(31),
      rrules.monthlyOnDay(-1),
      rrules.monthlyOnNthWeekday(4, 'SA'),
      rrules.yearly(2, 29),
    ]) {
      expect(() => parseRRule(rule)).not.toThrow();
    }
  });

  it('rejects out-of-range arguments with invalid_argument', () => {
    const calls = [
      () => rrules.daily(0),
      () => rrules.daily(1.5),
      () => rrules.daily(1000),
      () => rrules.weekly([]),
      () => rrules.weekly(['MO'], 0),
      () => rrules.monthlyOnDay(0),
      () => rrules.monthlyOnDay(32),
      () => rrules.monthlyOnDay(-2),
      () => rrules.monthlyOnNthWeekday(0, 'MO'),
      () => rrules.monthlyOnNthWeekday(5, 'MO'),
      () => rrules.monthlyOnNthWeekday(-2, 'MO'),
      () => rrules.yearly(0, 1),
      () => rrules.yearly(13, 1),
      () => rrules.yearly(1, 32),
    ];
    for (const call of calls) {
      expect(call).toThrow(RecurrenceError);
      try {
        call();
      } catch (error) {
        expect((error as RecurrenceError).code).toBe('invalid_argument');
      }
    }
  });
});
