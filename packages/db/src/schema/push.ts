import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './columns.js';
import { member } from './household.js';

/**
 * A browser a member turned on push notifications in (Web Push). The worker sends the member's
 * `web_push` notifications to every one of their subscriptions and deletes one the push service
 * says is gone. `endpoint` is unique: a browser that one member subscribed and another then
 * subscribes (a shared device) moves to the second member.
 */
export const pushSubscription = pgTable(
  'push_subscription',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    // The push service URL the message is POSTed to; it identifies the browser.
    endpoint: text('endpoint').notNull().unique(),
    // The browser's keys for encrypting the message (URL-safe base64).
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    // When a message was last accepted by the push service for it.
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('push_subscription_member_id_idx').on(t.memberId)],
);

export type PushSubscription = typeof pushSubscription.$inferSelect;
export type NewPushSubscription = typeof pushSubscription.$inferInsert;
