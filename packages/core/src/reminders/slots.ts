import type { IANAZone } from 'luxon';
import {
  fromWall,
  MS_PER_DAY,
  MS_PER_MINUTE,
  timeOfDayOf,
  toWall,
} from '../recurrence/calendar.js';
import { RecurrenceError } from '../recurrence/errors.js';

/*
 * Time-of-day helpers for the reminder planner. A time of day is held as the milliseconds since
 * local midnight, so it composes with the wall times of `recurrence/calendar.ts`.
 */

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * Milliseconds after local midnight of a `HH:MM` (the shared schema) or `HH:MM:SS` (a Postgres
 * `time` column) string. Throws `invalid_argument` for anything else.
 */
export function parseTimeOfDay(time: string, label: string): number {
  const match = TIME_OF_DAY.exec(time);
  if (match === null) {
    throw new RecurrenceError(
      'invalid_argument',
      `${label} must be HH:MM or HH:MM:SS (24-hour), got ${JSON.stringify(time)}`,
    );
  }
  return (
    Number(match[1]) * MS_PER_HOUR + Number(match[2]) * MS_PER_MINUTE + Number(match[3] ?? 0) * 1000
  );
}

/** Household quiet hours as times of day: `[start, end)`, wrapping midnight when `start > end`. */
export interface QuietHours {
  start: number;
  end: number;
}

/** True when `timeOfDay` is inside the quiet hours; equal `start` and `end` mean no quiet hours. */
function isQuiet(quiet: QuietHours, timeOfDay: number): boolean {
  if (quiet.start === quiet.end) return false;
  return quiet.start < quiet.end
    ? timeOfDay >= quiet.start && timeOfDay < quiet.end
    : timeOfDay >= quiet.start || timeOfDay < quiet.end;
}

/**
 * Returns a function that moves an instant out of the quiet hours. An instant outside them is
 * returned as is. One inside them moves to the first of the household `slots` (times of day)
 * at or after the end of that quiet period and outside the quiet hours; when no slot qualifies,
 * to the end of the quiet period itself.
 */
export function quietHoursAdjuster(
  zone: IANAZone,
  quiet: QuietHours,
  slots: readonly number[],
): (instantMs: number) => number {
  return (instantMs) => {
    const wall = toWall(zone, instantMs);
    const timeOfDay = timeOfDayOf(zone, instantMs);
    if (!isQuiet(quiet, timeOfDay)) return instantMs;
    // Before the end of the day's quiet period it ends today, else (a wrapping period) tomorrow.
    const endDay = wall - timeOfDay + (timeOfDay < quiet.end ? 0 : MS_PER_DAY);
    const usable = slots.filter((slot) => slot >= quiet.end && !isQuiet(quiet, slot));
    return fromWall(zone, endDay + (usable.length > 0 ? Math.min(...usable) : quiet.end));
  };
}
