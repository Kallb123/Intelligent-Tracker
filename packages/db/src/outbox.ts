import type { NotificationChannel } from '@tracker/shared';
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or, type SQL } from 'drizzle-orm';
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
 *
 * Where one message carries several notifications (the Telegram group gets all the reminders due
 * together as a single message), `deliverOutboxBatches` claims them a household at a time and
 * hands the handler the whole batch; success and failure then apply to every row of it.
 */

/** The first retry waits this long; each further failure doubles the wait. */
export const OUTBOX_RETRY_BASE_MS = 30_000;
/** No retry waits longer than this. */
export const OUTBOX_RETRY_MAX_MS = 60 * 60 * 1000;
export const DEFAULT_OUTBOX_BATCH_SIZE = 50;
/**
 * The most notifications `deliverOutboxBatches` puts in one message: Telegram caps a message at
 * 4096 characters and an inline keyboard at 100 buttons, and every reminder brings its own line
 * and row of buttons.
 */
export const DEFAULT_OUTBOX_MESSAGE_SIZE = 8;
/** The most messages one `deliverOutboxBatches` call sends, so one call cannot run unbounded. */
export const DEFAULT_OUTBOX_MAX_MESSAGES = 10;
/** Delivery is given up (`failed_at`) after this many failed attempts. */
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 8;

/**
 * How long to wait before retrying after the `attempts`-th failed attempt (1-based): 30 seconds,
 * doubling each time, capped at an hour.
 */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(OUTBOX_RETRY_BASE_MS * 2 ** (Math.max(1, attempts) - 1), OUTBOX_RETRY_MAX_MS);
}

/** What a handler may report about the message it sent. */
export type OutboxSent = { telegramMessageId?: number } | void;

/** Delivers one notification; throws to have it retried. */
export type OutboxHandler = (notification: Notification) => Promise<OutboxSent>;

/**
 * Delivers several notifications of one household and channel as one message; throws to have all
 * of them retried.
 */
export type OutboxBatchHandler = (notifications: Notification[]) => Promise<OutboxSent>;

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

/** Oldest first: the order in which pending notifications are claimed. */
const CLAIM_ORDER = [asc(notification.nextAttemptAt), asc(notification.id)] as const;

/** Rows on these channels that are still to deliver and whose next attempt is due. */
function isPending(channels: readonly NotificationChannel[], now: Date): SQL | undefined {
  return and(
    inArray(notification.channel, [...channels]),
    isNull(notification.sentAt),
    isNull(notification.failedAt),
    lte(notification.nextAttemptAt, now),
  );
}

/** Stamps rows as delivered, with the Telegram message id the handler reported, if any. */
async function markSent(
  tx: DbOrTransaction,
  ids: string[],
  now: Date,
  sent: OutboxSent,
): Promise<void> {
  await tx
    .update(notification)
    .set({
      sentAt: now,
      lastError: null,
      ...(sent?.telegramMessageId !== undefined
        ? { telegramMessageId: sent.telegramMessageId }
        : {}),
    })
    .where(inArray(notification.id, ids));
}

/**
 * Records a failed attempt on a row: counts it, keeps the error, delays the next attempt by
 * `outboxBackoffMs` and, on the `maxAttempts`-th, gives up (`failed_at`).
 */
async function markFailed(
  tx: DbOrTransaction,
  row: Notification,
  now: Date,
  error: unknown,
  maxAttempts: number,
): Promise<DeliveryFailure> {
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
  return { notificationId: row.id, channel: row.channel, attempts, error: message, gaveUp };
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
        .where(isPending(channels, now))
        .orderBy(...CLAIM_ORDER)
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return true;

      try {
        // `handlers` has an entry for every channel selected above.
        const sent = await (handlers[row.channel] as OutboxHandler)(row);
        await markSent(tx, [row.id], now, sent);
        result.delivered += 1;
      } catch (error) {
        result.failures.push(await markFailed(tx, row, now, error, maxAttempts));
      }
      return false;
    });
    if (done) break;
  }
  return result;
}

export interface DeliverOutboxBatchesOptions {
  now: Date;
  /** The one channel to deliver. */
  channel: NotificationChannel;
  handler: OutboxBatchHandler;
  /** The most notifications in one handler call. Default `DEFAULT_OUTBOX_MESSAGE_SIZE`. */
  batchSize?: number;
  /** The most handler calls in one call of this function. Default `DEFAULT_OUTBOX_MAX_MESSAGES`. */
  maxBatches?: number;
  /** Failed attempts before giving up. Default `DEFAULT_OUTBOX_MAX_ATTEMPTS`. */
  maxAttempts?: number;
}

/**
 * Like `deliverOutbox`, for a channel where one message carries several notifications: pending
 * rows of `channel` are claimed one household at a time, oldest first, up to `batchSize` of
 * them, and the handler is called once with all of them. The household is that of the oldest
 * pending row; its other pending rows follow it into the batch, so everything that fell due in
 * the same tick goes out together, and a household with more than `batchSize` pending gets
 * several messages in a row.
 *
 * The batch is claimed (`FOR UPDATE SKIP LOCKED`) in a transaction that stays open while the
 * handler runs, so concurrent callers never share a row. A handler that returns stamps `sent_at`
 * on every row (and the `telegram_message_id` it reports, which is what lets a button press
 * find the rows again). One that throws counts a failed attempt on every row, with the same
 * backoff and give-up as `deliverOutbox`, and returns one `DeliveryFailure` per row. Batches
 * are delivered until nothing is pending or `maxBatches` were handled; a batch that failed is
 * not retried within the call, as its rows wait out their backoff.
 */
export async function deliverOutboxBatches(
  db: Database,
  options: DeliverOutboxBatchesOptions,
): Promise<DeliverOutboxResult> {
  const { now, channel, handler } = options;
  const batchSize = options.batchSize ?? DEFAULT_OUTBOX_MESSAGE_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_OUTBOX_MAX_MESSAGES;
  const maxAttempts = options.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS;
  const result: DeliverOutboxResult = { delivered: 0, failures: [] };

  for (let handled = 0; handled < maxBatches; handled += 1) {
    const done = await db.transaction(async (tx): Promise<boolean> => {
      const [first] = await tx
        .select()
        .from(notification)
        .where(isPending([channel], now))
        .orderBy(...CLAIM_ORDER)
        .limit(1)
        .for('update', { skipLocked: true });
      if (!first) return true;

      // The first row is already locked by this transaction, so it is part of the batch; the
      // rest are the household's other pending rows that no one else holds.
      const rows = await tx
        .select()
        .from(notification)
        .where(and(isPending([channel], now), eq(notification.householdId, first.householdId)))
        .orderBy(...CLAIM_ORDER)
        .limit(batchSize)
        .for('update', { skipLocked: true });

      try {
        const sent = await handler(rows);
        await markSent(
          tx,
          rows.map((row) => row.id),
          now,
          sent,
        );
        result.delivered += rows.length;
      } catch (error) {
        for (const row of rows) {
          result.failures.push(await markFailed(tx, row, now, error, maxAttempts));
        }
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
