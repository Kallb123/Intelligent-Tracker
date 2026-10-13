import { z } from 'zod';

/**
 * Reminders and the notification outbox, shared by the worker (which writes them), the api (which
 * serves in-app notifications) and the web app. The enums mirror the Postgres enums in
 * `@tracker/db` exactly; `REMINDER_KINDS` also matches `ReminderKind` in `@tracker/core`.
 */

export const REMINDER_KINDS = ['heads_up', 'milestone', 'nudge', 'due', 'overdue'] as const;
export const REMINDER_STATUSES = ['planned', 'sent', 'cancelled'] as const;
/** `in_app` feeds the web app's bell; `telegram_group` is delivered by the bot (PR 12). */
export const NOTIFICATION_CHANNELS = ['in_app', 'telegram_group'] as const;

export const reminderKindSchema = z.enum(REMINDER_KINDS);
export const reminderStatusSchema = z.enum(REMINDER_STATUSES);
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

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
  /** Kind `milestone` only. */
  milestoneTitle: z.string().optional(),
  /** Kind `overdue` only: whole local days past the due date. */
  overdueDays: z.number().int().positive().optional(),
});

export type ReminderPayload = z.infer<typeof reminderPayloadSchema>;

