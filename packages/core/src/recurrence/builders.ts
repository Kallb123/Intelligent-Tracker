import { assertInteger, RecurrenceError } from './errors.js';
import { WEEKDAY_CODES, type WeekdayCode } from './rrule-parse.js';

function interval(value: number): number {
  assertInteger(value, 1, 999, 'interval');
  return value;
}

function dayOfMonth(value: number): number {
  // -1 is "the last day of the month"; other negatives are valid RFC 5545 but not offered here.
  if (value !== -1) assertInteger(value, 1, 31, 'day of month');
  return value;
}

/**
 * Builders for the common repeat patterns, so the UI never hand-writes an RRULE. Each returns an
 * RRULE value for `{ kind: 'fixed', rrule, start }`; weeks start on Monday.
 */
export const rrules = {
  /** Every `n` days. */
  daily: (n = 1): string => `FREQ=DAILY;INTERVAL=${interval(n)}`,

  /** On the given weekdays every `n` weeks (`weekly(['MO'], 2)` is fortnightly on Mondays). */
  weekly(days: readonly WeekdayCode[], n = 1): string {
    const chosen = WEEKDAY_CODES.filter((code) => days.includes(code));
    if (chosen.length === 0) {
      throw new RecurrenceError('invalid_argument', 'weekly needs at least one weekday');
    }
    return `FREQ=WEEKLY;INTERVAL=${interval(n)};BYDAY=${chosen.join(',')}`;
  },

  /** On a day of the month every `n` months; -1 is the last day. Months without it are skipped. */
  monthlyOnDay: (day: number, n = 1): string =>
    `FREQ=MONTHLY;INTERVAL=${interval(n)};BYMONTHDAY=${dayOfMonth(day)}`,

  /** On the nth weekday of the month (`n` 1 to 4, or -1 for the last), e.g. the last Friday. */
  monthlyOnNthWeekday(nth: number, weekday: WeekdayCode, n = 1): string {
    if (nth !== -1) assertInteger(nth, 1, 4, 'nth weekday');
    return `FREQ=MONTHLY;INTERVAL=${interval(n)};BYDAY=${nth}${weekday}`;
  },

  /** On a date every `n` years. 29 Feb only occurs in leap years; day -1 is the month's last. */
  yearly(month: number, day: number, n = 1): string {
    assertInteger(month, 1, 12, 'month');
    return `FREQ=YEARLY;INTERVAL=${interval(n)};BYMONTH=${month};BYMONTHDAY=${dayOfMonth(day)}`;
  },
};
