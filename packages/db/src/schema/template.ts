import type { TemplateBody } from '@tracker/shared';
import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './columns.js';
import { household } from './household.js';

/** Built-ins live in shared code; only household-authored templates need persistence. */
export const template = pgTable('template', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: uuid('household_id')
    .notNull()
    .references(() => household.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  keywords: text('keywords').array().notNull(),
  defaults: jsonb('defaults').$type<TemplateBody['defaults']>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
