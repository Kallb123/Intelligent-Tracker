import type { ReminderPayload } from '@tracker/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './columns.js';
import { notificationChannel, reminderKind, reminderStatus } from './enums.js';
import { household, member } from './household.js';
import { occurrence } from './task.js';

/** Extra fields a planned reminder carries, depending on its kind. */
export interface ReminderData {
  milestoneId?: string;
  milestoneTitle?: string;
  overdueDays?: number;
}

/**
 * One reminder the planner produced for an occurrence. The worker re-plans open occurrences and
 * replaces the `planned` rows; `sent` rows (already queued in the outbox) are never touched, and
 * `key` (the planner's stable key) makes each reminder one row per occurrence.
 */
export const reminder = pgTable(
  'reminder',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurrenceId: uuid('occurrence_id')
      .notNull()
      .references(() => occurrence.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    kind: reminderKind('kind').notNull(),
    // The occurrence's assignee when planned; null addresses the whole household.
    memberId: uuid('member_id').references(() => member.id, { onDelete: 'set null' }),
    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    status: reminderStatus('status').notNull().default('planned'),
    data: jsonb('data')
      .$type<ReminderData>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // When it was queued in the outbox (status `sent`).
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('reminder_occurrence_key_uq').on(t.occurrenceId, t.key),
    index('reminder_status_fire_at_idx').on(t.status, t.fireAt),
  ],
);

/**
 * The outbox: one row per message to deliver on one channel. `dedupe_key` is unique, so queuing
 * the same reminder twice (a retried or concurrent tick) inserts nothing. Undelivered rows are
 * retried with backoff (`attempts`, `next_attempt_at`) until `sent_at` or `failed_at` is set.
 * `in_app` rows are also the member's in-app notifications (`read_at`).
 */
export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => household.id, { onDelete: 'cascade' }),
    // Who it is for; null for a household-wide channel such as the Telegram group.
    memberId: uuid('member_id').references(() => member.id, { onDelete: 'cascade' }),
    reminderId: uuid('reminder_id').references(() => reminder.id, { onDelete: 'set null' }),
    channel: notificationChannel('channel').notNull(),
    payload: jsonb('payload').$type<ReminderPayload>().notNull(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    // Set when delivery is given up after too many attempts.
    failedAt: timestamp('failed_at', { withTimezone: true }),
    // bigint: see household.telegram_group_chat_id. Telegram message ids are only unique within
    // a chat, so a message is identified by the chat together with its id; both are stamped when
    // the batch is sent.
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check('notification_attempts_non_negative', sql`${t.attempts} >= 0`),
    check(
      'notification_in_app_has_member',
      sql`${t.channel} <> 'in_app' OR ${t.memberId} IS NOT NULL`,
    ),
    // The delivery queue: only rows still to deliver.
    index('notification_pending_idx')
      .on(t.channel, t.nextAttemptAt)
      .where(sql`${t.sentAt} IS NULL AND ${t.failedAt} IS NULL`),
    index('notification_member_created_at_idx').on(t.memberId, t.createdAt),
    // The bot finds the lines of a group message when one of its buttons is pressed.
    index('notification_telegram_message_idx')
      .on(t.householdId, t.telegramChatId, t.telegramMessageId)
      .where(sql`${t.telegramMessageId} IS NOT NULL`),
  ],
);

/** One row per worker-like service, touched every tick; `/api/health` reports when it is stale. */
export const serviceHeartbeat = pgTable('service_heartbeat', {
  service: text('service').primaryKey(),
  beatAt: timestamp('beat_at', { withTimezone: true }).notNull(),
});

export type Reminder = typeof reminder.$inferSelect;
export type NewReminder = typeof reminder.$inferInsert;
export type Notification = typeof notification.$inferSelect;
export type NewNotification = typeof notification.$inferInsert;
export type ServiceHeartbeat = typeof serviceHeartbeat.$inferSelect;
