import { IANAZone } from 'luxon';
import { DEFAULT_TIMEZONE } from '../timezone.js';
import { RecurrenceError } from './errors.js';
import type { Due, LocalDate } from './types.js';

/*
 * "Wall time" is a local date-time in the household zone encoded as the epoch milliseconds the
 * same digits would have in UTC (so 08:00 London in July is wall 08:00Z but instant 07:00Z).
 * Date arithmetic on wall times is plain integer maths and so can never be disturbed by DST;
 * only the final conversion back to an instant (`fromWall`) involves the zone.
 */

export const MS_PER_MINUTE = 60_000;
export const MS_PER_DAY = 86_400_000;

/** Latest wall time the engine will iterate to (rrule itself stops at the end of year 9999). */
export const MAX_WALL = Date.UTC(9999, 11, 31);

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates an IANA zone name (default `DEFAULT_TIMEZONE`) and returns the Luxon zone. */
export function resolveZone(timezone: string | undefined): IANAZone {
  const name = timezone ?? DEFAULT_TIMEZONE;
  const zone = IANAZone.create(name);
  if (!zone.isValid) {
    throw new RecurrenceError('invalid_timezone', `Unknown time zone: ${JSON.stringify(name)}`);
  }
  return zone;
}

export function assertValidInstant(value: Date, label: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new RecurrenceError('invalid_date', `${label} is an invalid Date`);
  }
}

/** `YYYY-MM-DD` of a wall time. */
export function formatLocalDate(wallMs: number): LocalDate {
  return new Date(wallMs).toISOString().slice(0, 10);
}

/** Midnight wall time of a `YYYY-MM-DD` string; throws `invalid_date` for impossible dates. */
export function parseLocalDate(date: LocalDate): number {
  const ms = LOCAL_DATE.test(date)
    ? Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
    : Number.NaN;
  // Date.UTC rolls 2026-02-30 over to March, so a round trip detects impossible dates. The
  // NaN case (bad format) never equals a string.
  if (Number.isNaN(ms) || formatLocalDate(ms) !== date) {
    throw new RecurrenceError(
      'invalid_date',
      `Not a valid YYYY-MM-DD date: ${JSON.stringify(date)}`,
    );
  }
  return ms;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return formatLocalDate(parseLocalDate(date) + days * MS_PER_DAY);
}

/** The wall time of an instant in `zone`. */
export function toWall(zone: IANAZone, instantMs: number): number {
  return instantMs + zone.offset(instantMs) * MS_PER_MINUTE;
}

/**
 * The instant at which `zone`'s clocks show `wallMs`. Deterministic at DST changes:
 * - a time that does not exist (spring-forward gap) moves forward by the length of the gap,
 *   so 01:30 on the last Sunday of March in London becomes 02:30 BST;
 * - a time that happens twice (autumn overlap) resolves to the first, earlier instant (BST).
 */
export function fromWall(zone: IANAZone, wallMs: number): number {
  const offsetBefore = zone.offset(wallMs - MS_PER_DAY);
  const offsetAfter = zone.offset(wallMs + MS_PER_DAY);
  const early = wallMs - offsetBefore * MS_PER_MINUTE;
  const late = wallMs - offsetAfter * MS_PER_MINUTE;
  // Away from any change both offsets agree. Around one, `early` is right unless the time falls
  // after the change; when it is valid under both offsets (the overlap) `early` is the earlier.
  if (zone.offset(early) === offsetBefore) return early;
  if (zone.offset(late) === offsetAfter) return late;
  // In the gap neither is consistent: keep the pre-change offset, which lands after the gap.
  return early;
}

/** The calendar date `instant` falls on in `zone`. */
export function localDateOf(zone: IANAZone, instant: Date): LocalDate {
  return formatLocalDate(toWall(zone, instant.getTime()));
}

/** Wall time of a due (midnight for all-day dues). */
export function wallOfDue(zone: IANAZone, due: Due): number {
  return due.allDay ? parseLocalDate(due.date) : toWall(zone, due.at.getTime());
}

export function dueFromWall(zone: IANAZone, allDay: boolean, wallMs: number): Due {
  return allDay
    ? { allDay: true, date: formatLocalDate(wallMs) }
    : { allDay: false, at: new Date(fromWall(zone, wallMs)) };
}

/** Throws unless the due is a real date / valid instant. */
export function assertValidDue(due: Due): void {
  if (due.allDay) {
    parseLocalDate(due.date);
  } else {
    assertValidInstant(due.at, 'Due instant');
  }
}

/** A string unique to the moment a due refers to; all-day and timed dues never collide. */
export function dueKey(due: Due): string {
  return due.allDay ? `d:${due.date}` : `t:${due.at.getTime()}`;
}

/**
 * Compares dues with an instant, returning <0, 0 or >0 for due before / at / after it.
 * All-day dues compare by the instant's local date in `zone`; timed dues by the instant itself.
 */
export function comparatorTo(zone: IANAZone, instant: Date): (due: Due) => number {
  const date = localDateOf(zone, instant);
  const ms = instant.getTime();
  return (due) => (due.allDay ? compare(due.date, date) : compare(due.at.getTime(), ms));
}

function compare(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
