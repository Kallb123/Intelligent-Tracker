import {
  addDays,
  assertValidDue,
  fromWall,
  localDateOf,
  MS_PER_DAY,
  parseLocalDate,
  resolveZone,
  assertValidInstant,
  wallOfDue,
} from './calendar.js';
import { nextAfterCompletion } from './after-completion.js';
import { assertInteger } from './errors.js';
import { expand, nextOccurrence } from './expand.js';
import { validateSchedule } from './schedule.js';
import type { Due, Schedule, ZoneOptions } from './types.js';

/** Dues are materialised at least this many days ahead. */
export const MIN_HORIZON_DAYS = 90;
/** Extra days beyond the lead time, so reminders for the due date are planned well ahead. */
export const HORIZON_PADDING_DAYS = 30;
const MAX_LEAD_TIME_DAYS = 3650;

function assertLeadTime(leadTimeDays: number): void {
  assertInteger(leadTimeDays, 0, MAX_LEAD_TIME_DAYS, 'leadTimeDays');
}

/** How many days ahead to keep occurrences materialised: `max(90, leadTime + 30)`. */
export function materialisationHorizonDays(leadTimeDays: number | null): number {
  if (leadTimeDays === null) return MIN_HORIZON_DAYS;
  assertLeadTime(leadTimeDays);
  return Math.max(MIN_HORIZON_DAYS, leadTimeDays + HORIZON_PADDING_DAYS);
}

/**
 * When the task becomes visible: `leadTimeDays` before the due, or `null` without a lead time.
 * An all-day due starts at local midnight; a timed due at the same local wall-clock time.
 */
export function startAtFor(
  due: Due,
  leadTimeDays: number | null,
  options: ZoneOptions = {},
): Date | null {
  assertValidDue(due);
  const zone = resolveZone(options.timezone);
  if (leadTimeDays === null) return null;
  assertLeadTime(leadTimeDays);
  const wall = wallOfDue(zone, due);
  return new Date(fromWall(zone, wall - leadTimeDays * MS_PER_DAY));
}

export interface MaterialiseOptions extends ZoneOptions {
  now: Date;
  leadTimeDays: number | null;
  /** For `after_completion`: the occurrence last completed, if any. Ignored by other kinds. */
  lastCompleted?: { completedAt: Date; due: Due } | undefined;
}

export interface MaterialisedDue {
  due: Due;
  /** `due - leadTimeDays` (see `startAtFor`), or `null` without a lead time. */
  startAt: Date | null;
}

/**
 * The dues the worker should have as occurrences right now. Pure and deterministic, so the worker
 * can call it every tick and insert whatever is missing (it must dedupe on task + due).
 *
 * - `fixed`: every due from the start of today (local) to `max(90, lead + 30)` days ahead, and
 *   always at least the next one, however far off. Dues before today are not returned: overdue
 *   rows already exist, and a worker that was down does not backfill history.
 * - `once`: its due (past ones included, for the worker to dedupe against the existing row), or
 *   nothing for an undated task, which the worker creates as an undated occurrence itself.
 * - `after_completion`: exactly one due: `nextAfterCompletion` of `lastCompleted`, or the start
 *   if it was never completed.
 */
export function occurrencesToMaterialise(
  schedule: Schedule,
  options: MaterialiseOptions,
): MaterialisedDue[] {
  validateSchedule(schedule);
  assertValidInstant(options.now, 'now');
  const horizon = materialisationHorizonDays(options.leadTimeDays);
  const zone = options.timezone;
  return duesFor(schedule, options, horizon).map((due) => ({
    due,
    startAt: startAtFor(due, options.leadTimeDays, { timezone: zone }),
  }));
}

function duesFor(schedule: Schedule, options: MaterialiseOptions, horizon: number): Due[] {
  switch (schedule.kind) {
    case 'once':
      return schedule.due === null ? [] : [schedule.due];
    case 'after_completion':
      return [
        options.lastCompleted
          ? nextAfterCompletion({
              intervalDays: schedule.intervalDays,
              completedAt: options.lastCompleted.completedAt,
              previousDue: options.lastCompleted.due,
              timezone: options.timezone,
            })
          : schedule.start,
      ];
    case 'fixed': {
      const zone = resolveZone(options.timezone);
      const today = localDateOf(zone, options.now);
      const from = new Date(fromWall(zone, parseLocalDate(today)));
      // The last millisecond of the horizon's final local day.
      const to = new Date(fromWall(zone, parseLocalDate(addDays(today, horizon + 1))) - 1);
      const dues = expand(schedule, {
        from,
        to,
        timezone: options.timezone,
        limit: horizon + 1,
      });
      const next = dues.length === 0 ? nextOccurrence(schedule, to, options) : null;
      return next === null ? dues : [next];
    }
  }
}
