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
