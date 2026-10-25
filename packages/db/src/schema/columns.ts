import { sql } from 'drizzle-orm';
import { timestamp, type AnyPgColumn } from 'drizzle-orm/pg-core';

/** A required timestamptz that defaults to the current time. */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** `updated_at`: set on insert and refreshed by Drizzle on every update made through it. */
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * Value for `updatedAt` in an `UPDATE ... SET` that leaves `updated_at` as it is. Drizzle's
 * `$onUpdate` bumps the column on every update unless the statement sets it, so bookkeeping that
 * is not an edit of the row (a stored plan hash, a pruned dead id) assigns the column to itself.
 */
export const keepUpdatedAt = (table: { updatedAt: AnyPgColumn }) => sql`${table.updatedAt}`;
