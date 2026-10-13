import { HOUSEHOLD_DEFAULTS } from '@tracker/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './columns.js';
import {
  assignmentMode,
  occurrenceStatus,
  reminderProfile,
  reminderSlot,
  scheduleKind,
} from './enums.js';
import { household, member } from './household.js';

/** A task definition (the "series"). Concrete instances live in `occurrence`. */
export const task = pgTable(
  'task',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => household.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    notes: text('notes').notNull().default(''),
    category: text('category'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    priority: smallint('priority').notNull().default(0),
    reminderSlot: reminderSlot('reminder_slot').notNull().default('evening'),
    reminderCustomTime: time('reminder_custom_time'),
    effortMinutes: integer('effort_minutes'),
    scheduleKind: scheduleKind('schedule_kind').notNull(),
    // All-day tasks use `due_date`; timed ones use `due_at` (an instant) and all_day = false.
    dueDate: date('due_date', { mode: 'string' }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    allDay: boolean('all_day').notNull().default(true),
    rrule: text('rrule'),
    intervalAfterCompletionDays: integer('interval_after_completion_days'),
    leadTimeDays: integer('lead_time_days'),
    reminderProfile: reminderProfile('reminder_profile')
      .notNull()
      .default(HOUSEHOLD_DEFAULTS.defaultReminderProfile),
    assignmentMode: assignmentMode('assignment_mode').notNull().default('fixed'),
    rotationCursor: integer('rotation_cursor').notNull().default(0),
    // template_id arrives with the template table in a later PR.
    createdBy: uuid('created_by').references(() => member.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('task_household_id_idx').on(t.householdId),
    check('task_all_day_matches_due_at', sql`${t.allDay} = (${t.dueAt} IS NULL)`),
    check('task_due_date_only_when_all_day', sql`${t.dueDate} IS NULL OR ${t.allDay}`),
    check(
      'task_custom_time_set',
      sql`${t.reminderSlot} <> 'custom_time' OR ${t.reminderCustomTime} IS NOT NULL`,
    ),
    check(
      'task_after_completion_interval',
      sql`${t.scheduleKind} <> 'after_completion' OR ${t.intervalAfterCompletionDays} IS NOT NULL`,
    ),
    check(
      'task_interval_positive',
      sql`${t.intervalAfterCompletionDays} IS NULL OR ${t.intervalAfterCompletionDays} > 0`,
    ),
    check('task_lead_time_non_negative', sql`${t.leadTimeDays} IS NULL OR ${t.leadTimeDays} >= 0`),
    check('task_effort_positive', sql`${t.effortMinutes} IS NULL OR ${t.effortMinutes} > 0`),
    check('task_rotation_cursor_non_negative', sql`${t.rotationCursor} >= 0`),
  ],
);

/**
 * The plan's ordered `assignees[]` in relational form: `position` is the rotation order
 * (0-based, unique per task).
 */
export const taskAssignee = pgTable(
  'task_assignee',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.memberId] }),
    unique('task_assignee_task_position_uq').on(t.taskId, t.position),
    index('task_assignee_member_id_idx').on(t.memberId),
    check('task_assignee_position_non_negative', sql`${t.position} >= 0`),
  ],
);

export const taskMilestone = pgTable(
  'task_milestone',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    offsetDaysBeforeDue: integer('offset_days_before_due').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [
    unique('task_milestone_task_position_uq').on(t.taskId, t.position),
    check('task_milestone_offset_non_negative', sql`${t.offsetDaysBeforeDue} >= 0`),
  ],
);

/** A concrete instance of a task, materialised by the worker. */
export const occurrence = pgTable(
  'occurrence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    // Same all-day rule as `task`: a date for all-day, an instant for timed, neither if undated.
    dueDate: date('due_date', { mode: 'string' }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    // due minus the task's lead time; before this the occurrence is only "coming up".
    startAt: timestamp('start_at', { withTimezone: true }),
    assigneeId: uuid('assignee_id').references(() => member.id, { onDelete: 'set null' }),
    status: occurrenceStatus('status').notNull().default('upcoming'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => member.id, { onDelete: 'set null' }),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    milestoneProgress: jsonb('milestone_progress')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Fingerprint of everything the reminder planner read (bar the clock) when the worker last
    // planned this occurrence's reminders; null until then. See `replanReminders`.
    reminderPlanHash: text('reminder_plan_hash'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('occurrence_single_due', sql`${t.dueDate} IS NULL OR ${t.dueAt} IS NULL`),
    // Materialisation must be idempotent: one occurrence per task per due date/instant.
    // NULLs are distinct, so each index only constrains rows that use that kind of due.
    unique('occurrence_task_due_date_uq').on(t.taskId, t.dueDate),
    unique('occurrence_task_due_at_uq').on(t.taskId, t.dueAt),
    // An undated one-off task has exactly one occurrence.
    uniqueIndex('occurrence_task_undated_uq')
      .on(t.taskId)
      .where(sql`${t.dueDate} IS NULL AND ${t.dueAt} IS NULL`),
    index('occurrence_status_due_date_idx').on(t.status, t.dueDate),
    index('occurrence_status_due_at_idx').on(t.status, t.dueAt),
    index('occurrence_status_start_at_idx').on(t.status, t.startAt),
    index('occurrence_assignee_status_idx').on(t.assigneeId, t.status),
  ],
);

export type Task = typeof task.$inferSelect;
export type NewTask = typeof task.$inferInsert;
export type TaskAssignee = typeof taskAssignee.$inferSelect;
export type NewTaskAssignee = typeof taskAssignee.$inferInsert;
export type TaskMilestone = typeof taskMilestone.$inferSelect;
export type NewTaskMilestone = typeof taskMilestone.$inferInsert;
export type Occurrence = typeof occurrence.$inferSelect;
export type NewOccurrence = typeof occurrence.$inferInsert;
