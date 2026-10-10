import { addLocalDays, localToday, startOfLocalDay } from '@tracker/core';
import { occurrence } from '@tracker/db';
import type { OccurrenceView } from '@tracker/shared';
import { and, gt, gte, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ViewOptions {
  now: Date;
  /** The household's time zone, which decides what "today" is. */
  timezone: string;
  /** How far ahead the `upcoming` view looks. */
  days: number;
}

/** Past its due: a timed due before `now`, or an all-day due before today. */
function pastDue(now: Date, today: string): SQL | undefined {
  return or(lt(occurrence.dueAt, now), lt(occurrence.dueDate, today));
}

/**
 * The `where` condition of an occurrence list view (on top of "open, not snoozed, not
 * archived", which the route adds):
 * - `today`: due before tomorrow starts (so overdue ones too), already within its lead time,
 *   or undated;
 * - `overdue`: past its due;
 * - `upcoming`: due from tomorrow up to `days` days ahead, or starting within the next `days`
 *   days.
 */
export function viewCondition(view: OccurrenceView, options: ViewOptions): SQL | undefined {
  const { now, timezone, days } = options;
  const today = localToday(now, timezone);
  const tomorrow = addLocalDays(today, 1);
  switch (view) {
    case 'overdue':
      return pastDue(now, today);
    case 'today':
      return or(
        lt(occurrence.dueDate, tomorrow),
        lt(occurrence.dueAt, startOfLocalDay(tomorrow, timezone)),
        lte(occurrence.startAt, now),
        and(isNull(occurrence.dueDate), isNull(occurrence.dueAt)),
      );
    case 'upcoming':
      return or(
        and(gte(occurrence.dueDate, tomorrow), lte(occurrence.dueDate, addLocalDays(today, days))),
        and(
          gte(occurrence.dueAt, startOfLocalDay(tomorrow, timezone)),
          lt(occurrence.dueAt, startOfLocalDay(addLocalDays(today, days + 1), timezone)),
        ),
        and(
          gt(occurrence.startAt, now),
          lte(occurrence.startAt, new Date(now.getTime() + days * DAY_MS)),
        ),
      );
  }
}

/**
 * List order: overdue first, then by due (an all-day due counts from local midnight), undated
 * last.
 */
export function viewOrder(options: ViewOptions): SQL[] {
  const { now, timezone } = options;
  const dueInstant = sql`coalesce(${occurrence.dueAt}, (${occurrence.dueDate}::timestamp AT TIME ZONE ${timezone}))`;
  return [
    sql`case when ${pastDue(now, localToday(now, timezone))} then 0 else 1 end`,
    sql`${dueInstant} asc nulls last`,
    sql`${occurrence.id} asc`,
  ];
}
