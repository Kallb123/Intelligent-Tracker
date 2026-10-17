import type { Due } from '@tracker/core';
import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { occurrence } from './schema/index.js';

/**
 * The one definition of an occurrence's due instant, for SQL: a timed due is its instant, an
 * all-day due is local midnight at the start of the date in `timezone` (a household time zone
 * name, or the column holding it). `NULL` for an undated occurrence.
 */
export function dueInstant(timezone: string | AnyPgColumn): SQL {
  return sql`coalesce(${occurrence.dueAt}, (${occurrence.dueDate}::timestamp AT TIME ZONE ${timezone}))`;
}

/** `ORDER BY` term for due order: earliest due first, undated last. Ties are left to the caller. */
export function dueOrder(timezone: string | AnyPgColumn): SQL {
  return sql`${dueInstant(timezone)} asc nulls last`;
}

/**
 * The due of an occurrence row (or anything with its `due_date` / `due_at` columns), in the shape
 * the recurrence and reminder code in `@tracker/core` takes: a timed due is its instant, an
 * all-day one its date, `null` when undated.
 */
export function dueOf(row: { dueDate: string | null; dueAt: Date | null }): Due | null {
  if (row.dueAt !== null) return { allDay: false, at: row.dueAt };
  if (row.dueDate !== null) return { allDay: true, date: row.dueDate };
  return null;
}

/**
 * Whether the due has passed: a timed due is before `now`, an all-day due is before `today` (the
 * household-local date of `now`). An undated occurrence is never past due.
 */
export function isPastDue(
  row: { dueDate: string | null; dueAt: Date | null },
  now: Date,
  today: string,
): boolean {
  return (row.dueAt !== null && row.dueAt < now) || (row.dueDate !== null && row.dueDate < today);
}
