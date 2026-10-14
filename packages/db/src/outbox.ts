import type { NotificationChannel } from '@tracker/shared';
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import type { Database, DbOrTransaction } from './client.js';
import { notification, type Notification } from './schema/index.js';

/*
 * Delivering the outbox. Rows in `notification` are queued by `queueDueReminders` (exactly once,
 * thanks to the unique `dedupe_key`) and delivered here by a handler per channel. Each row is
 * claimed in its own short transaction with `FOR UPDATE SKIP LOCKED`, so two deliverers never
 * work on the same row, one slow row does not block the rest, and a crash rolls the claim back
 * and leaves the row pending for the next run.
 *
 * Delivery to an external channel is therefore at-least-once: a crash between sending and
 * stamping `sent_at` sends the message again on the next run. Queuing is what the dedupe key
 * makes at-most-once, and handlers for external channels should be idempotent where they can.
 * An `in_app` notification needs no sending (the row is the notification), so its handler is a
 * no-op and delivery just stamps `sent_at`, which is when the member's bell starts showing it.
 */

/** The first retry waits this long; each further failure doubles the wait. */
export const OUTBOX_RETRY_BASE_MS = 30_000;
/** No retry waits longer than this. */
export const OUTBOX_RETRY_MAX_MS = 60 * 60 * 1000;
export const DEFAULT_OUTBOX_BATCH_SIZE = 50;
/** Delivery is given up (`failed_at`) after this many failed attempts. */
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 8;

/**
 * How long to wait before retrying after the `attempts`-th failed attempt (1-based): 30 seconds,
 * doubling each time, capped at an hour.
 */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(OUTBOX_RETRY_BASE_MS * 2 ** (Math.max(1, attempts) - 1), OUTBOX_RETRY_MAX_MS);
}

/** Delivers one notification; throws to have it retried. */
export type OutboxHandler = (
  notification: Notification,
) => Promise<{ telegramMessageId?: number } | void>;

export interface DeliveryFailure {
  notificationId: string;
  channel: NotificationChannel;
  /** Failed attempts so far, this one included. */
  attempts: number;
  error: string;
  /** True when this was the last attempt: the notification will not be retried. */
  gaveUp: boolean;
}

export interface DeliverOutboxResult {
  delivered: number;
  failures: DeliveryFailure[];
}

export interface DeliverOutboxOptions {
  now: Date;
  /** Only channels with a handler are claimed; rows of other channels are left to their owner. */
  handlers: Partial<Record<NotificationChannel, OutboxHandler>>;
  /** The most rows to work on in one call. Default `DEFAULT_OUTBOX_BATCH_SIZE`. */
  batchSize?: number;
  /** Failed attempts before giving up. Default `DEFAULT_OUTBOX_MAX_ATTEMPTS`. */
  maxAttempts?: number;
}

/**
 * Delivers pending notifications (`sent_at` and `failed_at` unset, `next_attempt_at <= now`) on
 * the channels that have a handler, oldest first, up to `batchSize`. A handler that returns
 * stamps `sent_at` (and `telegram_message_id` if it gives one). A handler that throws adds an
 * attempt, records `last_error` and delays the next attempt by `outboxBackoffMs`; the
 * `maxAttempts`-th failure sets `failed_at` and gives up. Failures are returned, not thrown;
 * only database errors are thrown.
 */
export async function deliverOutbox(
  db: Database,
  options: DeliverOutboxOptions,
): Promise<DeliverOutboxResult> {
  const { now, handlers } = options;
  const batchSize = options.batchSize ?? DEFAULT_OUTBOX_BATCH_SIZE;
  const maxAttempts = options.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS;
  const channels = Object.keys(handlers) as NotificationChannel[];
  const result: DeliverOutboxResult = { delivered: 0, failures: [] };
  if (channels.length === 0) return result;

  for (let handled = 0; handled < batchSize; handled += 1) {
    const done = await db.transaction(async (tx): Promise<boolean> => {
      const [row] = await tx
        .select()
        .from(notification)
        .where(
          and(
            inArray(notification.channel, channels),
            isNull(notification.sentAt),
            isNull(notification.failedAt),
            lte(notification.nextAttemptAt, now),
          ),
        )
        .orderBy(asc(notification.nextAttemptAt), asc(notification.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return true;

      try {
        // `handlers` has an entry for every channel selected above.
        const sent = await (handlers[row.channel] as OutboxHandler)(row);
        await tx
          .update(notification)
          .set({
            sentAt: now,
            lastError: null,
            ...(sent?.telegramMessageId !== undefined
              ? { telegramMessageId: sent.telegramMessageId }
              : {}),
          })
          .where(eq(notification.id, row.id));
        result.delivered += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        const gaveUp = attempts >= maxAttempts;
        await tx
          .update(notification)
          .set({
            attempts,
            lastError: message,
            nextAttemptAt: new Date(now.getTime() + outboxBackoffMs(attempts)),
            ...(gaveUp ? { failedAt: now } : {}),
          })
          .where(eq(notification.id, row.id));
        result.failures.push({
          notificationId: row.id,
          channel: row.channel,
          attempts,
          error: message,
          gaveUp,
        });
      }
      return false;
    });
    if (done) break;
  }
  return result;
}

/** An in-app notification is deleted this long after the member read it. */
export const READ_NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Any notification that was delivered (`sent_at`) or given up on (`failed_at`) is deleted this
 * long after it was queued, read or not. Pending ones are never deleted.
 */
export const OLD_NOTIFICATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Deletes notifications that are no longer needed, so the table (and the bell's queries) stay
 * small: delivered in-app ones read more than `READ_NOTIFICATION_RETENTION_MS` ago, and any that were
 * delivered or failed and are more than `OLD_NOTIFICATION_RETENTION_MS` old. A notification still
 * waiting for delivery (neither `sent_at` nor `failed_at`) is never deleted, however old. The
 * reminder that produced it stays `sent`, so deleting the row cannot make it be queued again.
 * Returns how many were deleted.
 */
export async function pruneNotifications(
  db: DbOrTransaction,
  options: { now: Date },
): Promise<number> {
  const { now } = options;
  const readBefore = new Date(now.getTime() - READ_NOTIFICATION_RETENTION_MS);
  const createdBefore = new Date(now.getTime() - OLD_NOTIFICATION_RETENTION_MS);
  const deleted = await db
    .delete(notification)
    .where(
      or(
        and(
          eq(notification.channel, 'in_app'),
          isNotNull(notification.sentAt),
          isNotNull(notification.readAt),
          lt(notification.readAt, readBefore),
        ),
        and(
          lt(notification.createdAt, createdBefore),
          or(isNotNull(notification.sentAt), isNotNull(notification.failedAt)),
        ),
      ),
    )
    .returning({ id: notification.id });
  return deleted.length;
}
