import {
  describeReminder,
  HOUSEHOLD_DEFAULTS,
  isPushServiceEndpoint,
  type PushMessage,
} from '@tracker/shared';
import type { ReminderKind, ReminderPayload } from '@tracker/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Database } from './client.js';
import type { OutboxHandler } from './outbox.js';
import { MISSED_REMINDER_GRACE_MS } from './reminders.js';
import { household, pushSubscription, type Notification } from './schema/index.js';

/*
 * Delivering Web Push notifications. A `web_push` notification in the outbox is one reminder for
 * one member; delivering it sends the reminder to every browser the member subscribed (their
 * `push_subscription` rows). The handler here plugs into `deliverOutbox`. The push service is
 * reached through an injected `PushSender`, so this module does no network I/O of its own: the
 * worker supplies a sender built on the `web-push` library, and tests supply a fake.
 *
 * What the outcome of one notification means:
 *
 * - A subscription the push service accepts is stamped `last_sent_at`. One accepted send is
 *   enough to count the notification as delivered, and it is not sent again to the browsers
 *   that already have it, even if another of the member's browsers failed.
 * - A subscription the push service says is gone (404 or 410) is deleted: the browser
 *   unsubscribed or the subscription expired, and it will never work again.
 * - A subscription whose endpoint is not a known push service (`isPushServiceEndpoint`) is
 *   deleted without being sent to. The api refuses to save such an endpoint, so a row like this
 *   was not written by the app; the worker must never POST to a host a member chose.
 * - Any other failure (a network error, a timeout, a 5xx, a rejected request) is thrown when no
 *   subscription accepted the notification, so the outbox retries it with backoff. The ones
 *   that failed this way are kept. When another subscription did accept it, the notification
 *   counts as delivered and those failures are reported to `onPartialFailure` instead, so they
 *   are not lost silently.
 * - A member with no subscriptions left (all gone, or removed since the row was queued) has
 *   nothing to deliver to, which counts as delivered.
 */

/** Where one browser's push messages go: the fields of a `push_subscription` the sender needs. */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSendOptions {
  /** How long the push service keeps the message for a browser that is offline, in seconds. */
  ttlSeconds: number;
  /** `high` wakes a sleeping device now; `normal` lets the push service batch the message. */
  urgency: 'high' | 'normal';
}

/**
 * Sends one message to one browser; throws when the push service does not accept it. An error
 * carrying a numeric `statusCode` is the push service's HTTP status (`web-push` throws such
 * errors), which is how a gone subscription is recognised (`isPushGone`).
 */
export type PushSender = (
  target: PushTarget,
  message: PushMessage,
  options: PushSendOptions,
) => Promise<void>;

/**
 * Push messages are kept for as long as the outbox would still deliver the reminder
 * (`MISSED_REMINDER_GRACE_MS`): after that a browser that was offline has no use for it.
 */
export const PUSH_TTL_SECONDS = Math.floor(MISSED_REMINDER_GRACE_MS / 1000);

/** The title of every push notification; the reminder text goes in the body. */
export const PUSH_APP_TITLE = 'Intelligent Tracker';

/** Whether the push service says the subscription no longer exists (HTTP 404 or 410). */
export function isPushGone(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return status === 404 || status === 410;
}

/** Reminders that are due or overdue are urgent; the rest can wait for the device to wake. */
function urgencyOf(kind: ReminderKind): PushSendOptions['urgency'] {
  return kind === 'due' || kind === 'overdue' ? 'high' : 'normal';
}

/**
 * What the service worker shows for a reminder: the same sentence as the in-app bell and
 * Telegram (`describeReminder`, with the time in the household's zone), a `tag` per occurrence
 * so a newer reminder of the same job replaces the older one, and the Today page to open.
 */
export function renderPushMessage(payload: ReminderPayload, timeZone: string): PushMessage {
  return {
    title: PUSH_APP_TITLE,
    body: describeReminder(payload, timeZone),
    tag: `occurrence:${payload.occurrenceId}`,
    url: '/',
  };
}

/**
 * A notification that reached some of a member's browsers while the push service rejected it
 * for others (for a reason other than the subscription being gone). Those browsers are not
 * retried, so this is how the failures are reported.
 */
export interface PushPartialFailure {
  notificationId: string;
  memberId: string;
  /** How many subscriptions accepted the message. */
  accepted: number;
  /** How many failed. */
  failed: number;
  /** The distinct error messages of the failed ones. */
  errors: string[];
}

export interface WebPushHandlerOptions {
  send: PushSender;
  /** The delivery time, stamped on `last_sent_at`. */
  now: Date;
  /**
   * Called once, after the outcome is recorded, when at least one subscription accepted the
   * notification and others failed. Optional; the worker logs a warning with it. An error it
   * throws is ignored: the notification is already delivered and must not be retried.
   */
  onPartialFailure?: (failure: PushPartialFailure) => void;
}

/**
 * The `deliverOutbox` handler for the `web_push` channel: see the module comment for the rules.
 * A notification without a member (not produced by `queueDueReminders`) has nobody to push to
 * and is delivered as a no-op.
 */
export function createWebPushHandler(db: Database, options: WebPushHandlerOptions): OutboxHandler {
  const { send, now, onPartialFailure } = options;
  return async (row: Notification): Promise<void> => {
    if (!row.memberId) return;
    const subscriptions = await db
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.memberId, row.memberId));
    if (subscriptions.length === 0) return;
    const [home] = await db
      .select({ timezone: household.timezone })
      .from(household)
      .where(eq(household.id, row.householdId));
    const message = renderPushMessage(row.payload, home?.timezone ?? HOUSEHOLD_DEFAULTS.timezone);
    const sendOptions: PushSendOptions = {
      ttlSeconds: PUSH_TTL_SECONDS,
      urgency: urgencyOf(row.payload.kind),
    };

    const accepted: string[] = [];
    // Includes the rows whose endpoint is not a push service, which are never sent to.
    const gone: string[] = [];
    const errors: string[] = [];
    await Promise.all(
      subscriptions.map(async (subscription) => {
        if (!isPushServiceEndpoint(subscription.endpoint)) {
          gone.push(subscription.id);
          return;
        }
        try {
          await send(subscription, message, sendOptions);
          accepted.push(subscription.id);
        } catch (error) {
          if (isPushGone(error)) gone.push(subscription.id);
          else errors.push(error instanceof Error ? error.message : String(error));
        }
      }),
    );

    if (accepted.length > 0) {
      await db
        .update(pushSubscription)
        .set({ lastSentAt: now })
        .where(inArray(pushSubscription.id, accepted));
    }
    if (gone.length > 0) {
      await db.delete(pushSubscription).where(inArray(pushSubscription.id, gone));
    }
    if (errors.length === 0) return;
    const distinct = [...new Set(errors)];
    if (accepted.length === 0) {
      throw new Error(
        `Web Push failed for ${errors.length} subscription${errors.length === 1 ? '' : 's'}: ${distinct.join('; ')}`,
      );
    }
    try {
      onPartialFailure?.({
        notificationId: row.id,
        memberId: row.memberId,
        accepted: accepted.length,
        failed: errors.length,
        errors: distinct,
      });
    } catch {
      // A broken logger must not turn a delivered notification into a retry.
    }
  };
}
