import { timestamp } from 'drizzle-orm/pg-core';

/** A required timestamptz that defaults to the current time. */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** `updated_at`: set on insert and refreshed by Drizzle on every update made through it. */
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
