import { pgEnum } from 'drizzle-orm/pg-core';
import { NOTIFICATION_CHANNELS, REMINDER_KINDS, REMINDER_STATUSES } from '@tracker/shared';

export const memberRole = pgEnum('member_role', ['admin', 'member']);

/** What a one-time password link is for: a new member's first password, or an admin reset. */
export const passwordTokenPurpose = pgEnum('password_token_purpose', ['invite', 'reset']);

export const scheduleKind = pgEnum('schedule_kind', ['once', 'fixed', 'after_completion']);

export const reminderSlot = pgEnum('reminder_slot', ['evening', 'morning', 'custom_time']);

export const reminderProfile = pgEnum('reminder_profile', [
  'silent',
  'gentle',
  'standard',
  'persistent',
]);

export const assignmentMode = pgEnum('assignment_mode', ['fixed', 'any', 'rotation']);

export const occurrenceStatus = pgEnum('occurrence_status', [
  'upcoming',
  'active',
  'started',
  'done',
  'skipped',
]);

export const bankHolidayRegion = pgEnum('bank_holiday_region', [
  'england-and-wales',
  'scotland',
  'northern-ireland',
]);

export const reminderKind = pgEnum('reminder_kind', REMINDER_KINDS);

export const reminderStatus = pgEnum('reminder_status', REMINDER_STATUSES);

export const notificationChannel = pgEnum('notification_channel', NOTIFICATION_CHANNELS);
