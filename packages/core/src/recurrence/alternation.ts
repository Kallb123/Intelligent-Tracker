import { dueKey, MS_PER_DAY, resolveZone, wallOfDue } from './calendar.js';
import { assertInteger } from './errors.js';
import { walkSchedule } from './expand.js';
import { validateSchedule } from './schedule.js';
import type { Due, FixedSchedule, ZoneOptions } from './types.js';

/**
 * For alternating jobs (recycling one week, general waste the next): which of `alternatives`
 * variants applies to `due`. The index is the number of occurrences of the base schedule between
 * its start and `due`, modulo `alternatives`, so the first occurrence is 0, the second 1, and so
 * on. Because it counts occurrences, not weeks, it also works for monthly and other rules.
 * Returns `null` when `due` is not an occurrence of the schedule.
 */
export function alternationIndex(
  schedule: FixedSchedule,
  due: Due,
  alternatives: number,
  options: ZoneOptions = {},
): number | null {
  validateSchedule(schedule);
  assertInteger(alternatives, 2, 52, 'alternatives');
  const zone = resolveZone(options.timezone);
  const target = dueKey(due);
  let position = 0;
  let result = null as number | null;
  const maxWall = wallOfDue(zone, due) + MS_PER_DAY;
  walkSchedule(schedule, zone, maxWall, (candidate) => {
    if (dueKey(candidate) === target) {
      result = position % alternatives;
      return false;
    }
    position += 1;
    return true;
  });
  return result;
}
