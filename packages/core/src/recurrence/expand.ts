import type { IANAZone } from 'luxon';
import {
  assertValidInstant,
  comparatorTo,
  dueFromWall,
  MAX_WALL,
  MS_PER_DAY,
  resolveZone,
  toWall,
  wallOfDue,
} from './calendar.js';
import { assertInteger } from './errors.js';
import { parseRRule, RRule, untilWall } from './rrule-parse.js';
import { validateSchedule } from './schedule.js';
import type { Due, FixedSchedule, Schedule, ZoneOptions } from './types.js';

/** Default cap on the number of dues `expand` returns. */
export const DEFAULT_EXPAND_LIMIT = 1000;
const MAX_EXPAND_LIMIT = 100_000;
const MAX_PREVIEW_COUNT = 1000;

export interface ExpandOptions extends ZoneOptions {
  /** Inclusive lower bound (an instant). */
  from: Date;
  /** Inclusive upper bound (an instant). */
  to: Date;
  /** Keep at most this many dues (the earliest ones). Default `DEFAULT_EXPAND_LIMIT`. */
  limit?: number | undefined;
}

/**
 * Calls `visit` with each due of a fixed schedule in ascending order until it returns false.
 *
 * The rule runs on wall-clock times ("floating time", DTSTART with no zone) and each result is
 * converted to a real instant afterwards, so a daily 08:00 rule stays 08:00 local across BST/GMT.
 * `maxWall` bounds how far rrule searches, which also stops rules that never match from spinning.
 */
function walkFixed(
  schedule: FixedSchedule,
  zone: IANAZone,
  maxWall: number,
  visit: (due: Due) => boolean,
): void {
  const rule = parseRRule(schedule.rrule);
  const allDay = schedule.start.allDay;
  const series = new RRule({
    ...rule.options,
    dtstart: new Date(wallOfDue(zone, schedule.start)),
    until: new Date(Math.min(untilWall(rule, zone), maxWall)),
  });
  series.all((wall) => visit(dueFromWall(zone, allDay, wall.getTime())));
}

/** Visits a schedule's dues in ascending order until `visit` returns false (validated inputs). */
export function walkSchedule(
  schedule: Schedule,
  zone: IANAZone,
  maxWall: number,
  visit: (due: Due) => boolean,
): void {
  switch (schedule.kind) {
    case 'once':
      if (schedule.due !== null) visit(schedule.due);
      return;
    case 'after_completion':
      // Later dues depend on when the previous one is completed (see `nextAfterCompletion`).
      visit(schedule.start);
      return;
    case 'fixed':
      walkFixed(schedule, zone, maxWall, visit);
      return;
  }
}

/**
 * The dues of `schedule` between `from` and `to` (both inclusive), ascending, at most `limit`.
 *
 * `from` and `to` are instants. A timed due is in range when its instant is; an all-day due is in
 * range when its date lies between the local dates (in the zone) of `from` and `to`.
 *
 * A `once` schedule yields its single due and `after_completion` yields only its start, if in
 * range. Results follow RFC 5545 for month ends: `BYMONTHDAY=31` skips months without a 31st, a
 * monthly rule starting on the 31st does the same, and a yearly rule on 29 Feb only fires in leap
 * years. The start itself is only a due when it matches the rule (as in rrule.js).
 */
export function expand(schedule: Schedule, options: ExpandOptions): Due[] {
  validateSchedule(schedule);
  const zone = resolveZone(options.timezone);
  assertValidInstant(options.from, 'from');
  assertValidInstant(options.to, 'to');
  const limit = options.limit ?? DEFAULT_EXPAND_LIMIT;
  assertInteger(limit, 1, MAX_EXPAND_LIMIT, 'limit');

  const againstFrom = comparatorTo(zone, options.from);
  const againstTo = comparatorTo(zone, options.to);
  const result: Due[] = [];
  // One extra day of slack covers the offset between wall time and the real instant of `to`.
  const maxWall = Math.min(toWall(zone, options.to.getTime()) + MS_PER_DAY, MAX_WALL);
  walkSchedule(schedule, zone, maxWall, (due) => {
    if (againstTo(due) > 0) return false;
    if (againstFrom(due) >= 0) result.push(due);
    return result.length < limit;
  });
  return result;
}

/**
 * The first due strictly after `after` (all-day dues: on a later local date than `after`), or
 * `null` if the schedule has none. For `after_completion` that is only the start due.
 */
export function nextOccurrence(
  schedule: Schedule,
  after: Date,
  options: ZoneOptions = {},
): Due | null {
  validateSchedule(schedule);
  const zone = resolveZone(options.timezone);
  assertValidInstant(after, 'after');
  const againstAfter = comparatorTo(zone, after);
  let found = null as Due | null;
  walkSchedule(schedule, zone, MAX_WALL, (due) => {
    if (againstAfter(due) <= 0) return true;
    found = due;
    return false;
  });
  return found;
}

/** The next `count` (default 5) dues on or after `from`: the editor's "next dates" preview. */
export function previewDates(
  schedule: Schedule,
  from: Date,
  count = 5,
  options: ZoneOptions = {},
): Due[] {
  validateSchedule(schedule);
  const zone = resolveZone(options.timezone);
  assertValidInstant(from, 'from');
  assertInteger(count, 1, MAX_PREVIEW_COUNT, 'count');
  const againstFrom = comparatorTo(zone, from);
  const result: Due[] = [];
  walkSchedule(schedule, zone, MAX_WALL, (due) => {
    if (againstFrom(due) >= 0) result.push(due);
    return result.length < count;
  });
  return result;
}
