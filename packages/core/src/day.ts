import {
  addDays,
  assertValidInstant,
  fromWall,
  localDateOf,
  parseLocalDate,
  resolveZone,
} from './recurrence/calendar.js';
import type { LocalDate } from './recurrence/types.js';

/**
 * The calendar date `now` falls on in `timezone` (default `DEFAULT_TIMEZONE`), as `YYYY-MM-DD`.
 * Throws `RecurrenceError` for an unknown zone or an invalid `now`.
 */
export function localToday(now: Date, timezone?: string): LocalDate {
  assertValidInstant(now, 'now');
  return localDateOf(resolveZone(timezone), now);
}

/**
 * The instant local midnight starts `date` in `timezone` (default `DEFAULT_TIMEZONE`). DST-safe:
 * a day is 23 or 25 hours long when clocks change, and in a zone whose clocks skip midnight the
 * day starts at the first instant after the gap. Throws `RecurrenceError` for an impossible date
 * or unknown zone.
 */
export function startOfLocalDay(date: LocalDate, timezone?: string): Date {
  const zone = resolveZone(timezone);
  return new Date(fromWall(zone, parseLocalDate(date)));
}

/**
 * `date` shifted by a whole number of calendar days (negative goes back). Pure calendar
 * arithmetic, so it never drifts across DST changes. Throws `RecurrenceError` for an impossible
 * date.
 */
export function addLocalDays(date: LocalDate, days: number): LocalDate {
  return addDays(date, days);
}
