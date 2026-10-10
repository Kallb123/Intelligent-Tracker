import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt } from './columns.js';
import { household, member } from './household.js';
import { occurrence, task } from './task.js';

/** Append-only log of who did what, when. Drives history, fairness stats and suggestions. */
export const activity = pgTable(
  'activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => household.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').references(() => member.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => task.id, { onDelete: 'set null' }),
    occurrenceId: uuid('occurrence_id').references(() => occurrence.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    data: jsonb('data')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index('activity_household_created_at_idx').on(t.householdId, t.createdAt),
    index('activity_task_id_idx').on(t.taskId),
  ],
);

export type Activity = typeof activity.$inferSelect;
export type NewActivity = typeof activity.$inferInsert;
