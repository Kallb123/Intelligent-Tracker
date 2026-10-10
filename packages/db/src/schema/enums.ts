import { pgEnum } from 'drizzle-orm/pg-core';

export const memberRole = pgEnum('member_role', ['admin', 'member']);

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
