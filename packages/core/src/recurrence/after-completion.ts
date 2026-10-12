import {
  addDays,
  assertValidInstant,
  fromWall,
  localDateOf,
  parseLocalDate,
  resolveZone,
  timeOfDayOf,
} from './calendar.js';
import { assertInteger } from './errors.js';
import { MAX_INTERVAL_DAYS } from './schedule.js';
import type { Due, ZoneOptions } from './types.js';

export interface NextAfterCompletionInput extends ZoneOptions {
  intervalDays: number;
  /** When the occurrence was actually completed. */
  completedAt: Date;
  /** The due of the occurrence that was completed; decides all-day vs timed and the time of day. */
  previousDue: Due;
}

/**
 * The next due of an `after_completion` task: the local date of `completedAt` plus
 * `intervalDays`. All-day stays a date; a timed due keeps the previous due's local wall-clock
 * time (so it is still 19:00 after a clock change). A task completed late therefore drifts later.
 */
export function nextAfterCompletion(input: NextAfterCompletionInput): Due {
  assertInteger(input.intervalDays, 1, MAX_INTERVAL_DAYS, 'intervalDays');
  assertValidInstant(input.completedAt, 'completedAt');
  const zone = resolveZone(input.timezone);
  const date = addDays(localDateOf(zone, input.completedAt), input.intervalDays);
  const previous = input.previousDue;
  if (previous.allDay) return { allDay: true, date };
  assertValidInstant(previous.at, 'previousDue');
  const timeOfDay = timeOfDayOf(zone, previous.at.getTime());
  return { allDay: false, at: new Date(fromWall(zone, parseLocalDate(date) + timeOfDay)) };
}
