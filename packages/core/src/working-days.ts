import {
  addDays,
  dueFromWall,
  parseLocalDate,
  resolveZone,
  wallOfDue,
  MS_PER_DAY,
} from './recurrence/calendar.js';
import type { MaterialisedDue } from './recurrence/horizon.js';

/**
 * Move dues forward to a weekday outside the cached holidays, and not before the local date
 * `notBefore` if given, preserving local time and lead.
 */
export function onWorkingDay(
  planned: MaterialisedDue,
  holidays: ReadonlySet<string>,
  timezone: string,
  notBefore = '',
): MaterialisedDue {
  const zone = resolveZone(timezone);
  const originalWall = wallOfDue(zone, planned.due);
  let date = new Date(originalWall).toISOString().slice(0, 10);
  let days = 0;
  while (
    date < notBefore ||
    [0, 6].includes(new Date(parseLocalDate(date)).getUTCDay()) ||
    holidays.has(date)
  ) {
    date = addDays(date, 1);
    days++;
  }
  if (!days) return planned;
  const due = dueFromWall(zone, planned.due.allDay, originalWall + days * MS_PER_DAY);
  // Shift the prep start by calendar days too, keeping its wall time through BST changes.
  const startAt =
    planned.startAt === null
      ? null
      : dueFromWall(
          zone,
          false,
          wallOfDue(zone, { allDay: false, at: planned.startAt }) + days * MS_PER_DAY,
        );
  return { due, startAt: startAt && !startAt.allDay ? startAt.at : null };
}
