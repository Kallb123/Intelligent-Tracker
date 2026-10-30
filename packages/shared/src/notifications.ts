import { z } from 'zod';

/**
 * Reminders and the notification outbox, shared by the worker (which writes them), the api (which
 * serves in-app notifications) and the web app. The enums mirror the Postgres enums in
 * `@tracker/db` exactly. `REMINDER_KINDS` is the single source of the reminder kinds: `@tracker/core`'s
 * planner takes `ReminderKind` from here, and its order is the order the planner returns reminders
 * of the same instant in.
 */

export const REMINDER_KINDS = ['heads_up', 'milestone', 'nudge', 'due', 'overdue'] as const;
export const REMINDER_STATUSES = ['planned', 'sent', 'cancelled'] as const;
/**
 * `in_app` feeds the web app's bell; `telegram_group` is delivered by the bot (PR 12); `web_push`
 * is delivered by the worker to the member's subscribed browsers (Web Push, see `push.ts`).
 */
export const NOTIFICATION_CHANNELS = ['in_app', 'telegram_group', 'web_push'] as const;

/**
 * The scheduled Telegram digests: the `morning` digest of the day's jobs every day, and the
 * `week_ahead` on Sundays. Mirrors the Postgres enum `digest_kind`.
 */
export const DIGEST_KINDS = ['morning', 'week_ahead'] as const;

export const reminderKindSchema = z.enum(REMINDER_KINDS);
export const reminderStatusSchema = z.enum(REMINDER_STATUSES);
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

export type DigestKind = (typeof DIGEST_KINDS)[number];
export type ReminderKind = z.infer<typeof reminderKindSchema>;
export type ReminderStatus = z.infer<typeof reminderStatusSchema>;
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

/**
 * What a reminder notification says, captured when it is queued so it still reads correctly
 * after the task is edited or the occurrence deleted. Exactly one of `dueDate` (all-day) and
 * `dueAt` (timed) is set.
 */
export const reminderPayloadSchema = z.object({
  type: z.literal('reminder'),
  kind: reminderKindSchema,
  taskId: z.uuid(),
  occurrenceId: z.uuid(),
  taskTitle: z.string(),
  dueDate: z.iso.date().nullable(),
  dueAt: z.iso.datetime({ offset: true }).nullable(),
  /** When the reminder was planned to fire. */
  fireAt: z.iso.datetime({ offset: true }),
  /** The member the reminder is for; `null` when the occurrence has no assignee. */
  assigneeId: z.uuid().nullable(),
  /**
   * Kind `milestone` only. The id lets the Telegram message tick the milestone off; reminders
   * queued by an older version lack it and get no such button.
   */
  milestoneId: z.uuid().optional(),
  /** Kind `milestone` only. */
  milestoneTitle: z.string().optional(),
  /** Kind `overdue` only: whole local days past the due date. */
  overdueDays: z.number().int().positive().optional(),
  /**
   * The task's effort when the reminder was queued, so the evening digest can list quick jobs
   * first. Optional, as is `escalated`: notifications queued by an older version still parse.
   */
  effortMinutes: z.number().int().positive().nullable().optional(),
  /** Kind `overdue` only: still overdue after several days on a `persistent` task; louder. */
  escalated: z.literal(true).optional(),
  /**
   * The reminder fired at the household's evening slot, as it was when queued, which makes the
   * Telegram message that carries it "Tonight's jobs". Frozen in the payload so that changing
   * the slot later does not change a message already sent. Optional: older ones lack it.
   */
  tonight: z.literal(true).optional(),
});

export type ReminderPayload = z.infer<typeof reminderPayloadSchema>;

/** One in-app notification as the api serves it (`GET /api/notifications`). */
export const notificationSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  /** When the member read it; `null` while unread. */
  readAt: z.iso.datetime({ offset: true }).nullable(),
  payload: reminderPayloadSchema,
});

export const notificationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const notificationsResponseSchema = z.object({
  /** The caller's newest sent in-app notifications, newest first. */
  items: z.array(notificationSchema),
  /** All unread ones, not only those in `items`. */
  unreadCount: z.number().int().nonnegative(),
});

export type NotificationDto = z.infer<typeof notificationSchema>;
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>;
