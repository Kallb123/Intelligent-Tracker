import type { MilestoneInput, ReminderProfile, TaskBody } from '@tracker/shared';
import type { TaskValues } from './tasks.js';

/**
 * A task's editable fields in the one normalised shape the api compares and stores: every
 * optional field is `null` rather than missing, and `dueAt` is still an ISO string (as in the
 * DTO), so a stored task and a request body can be diffed field by field.
 */
export interface TaskFieldValues {
  title: string;
  notes: string;
  category: string | null;
  tags: string[];
  priority: number;
  reminderSlot: TaskBody['reminderSlot'];
  reminderCustomTime: string | null;
  effortMinutes: number | null;
  scheduleKind: TaskBody['scheduleKind'];
  allDay: boolean;
  dueDate: string | null;
  dueAt: string | null;
  rrule: string | null;
  intervalAfterCompletionDays: number | null;
  workingDaysOnly: boolean;
  remindOffsetDays: number;
  leadTimeDays: number | null;
  reminderProfile: ReminderProfile;
  assignmentMode: TaskBody['assignmentMode'];
  assigneeIds: string[];
  milestones: MilestoneInput[];
}

/**
 * A validated body in normalised form. A custom reminder time only means something for the
 * `custom_time` slot, so it is dropped for the others; a missing reminder profile becomes the
 * household's default.
 */
export function normaliseBody(body: TaskBody, defaultProfile: ReminderProfile): TaskFieldValues {
  return {
    title: body.title,
    notes: body.notes,
    category: body.category ?? null,
    tags: body.tags,
    priority: body.priority,
    reminderSlot: body.reminderSlot,
    reminderCustomTime:
      body.reminderSlot === 'custom_time' ? (body.reminderCustomTime ?? null) : null,
    effortMinutes: body.effortMinutes ?? null,
    scheduleKind: body.scheduleKind,
    allDay: body.allDay,
    dueDate: body.dueDate ?? null,
    dueAt: body.dueAt ?? null,
    rrule: body.rrule ?? null,
    intervalAfterCompletionDays: body.intervalAfterCompletionDays ?? null,
    workingDaysOnly: body.workingDaysOnly,
    remindOffsetDays: body.remindOffsetDays,
    leadTimeDays: body.leadTimeDays ?? null,
    reminderProfile: body.reminderProfile ?? defaultProfile,
    assignmentMode: body.assignmentMode,
    assigneeIds: body.assigneeIds,
    milestones: body.milestones,
  };
}

/** The `task` row columns for these fields (not the assignees and milestones, which are tables). */
export function taskColumns(fields: TaskFieldValues): TaskValues {
  return {
    title: fields.title,
    notes: fields.notes,
    category: fields.category,
    tags: fields.tags,
    priority: fields.priority,
    reminderSlot: fields.reminderSlot,
    reminderCustomTime: fields.reminderCustomTime,
    effortMinutes: fields.effortMinutes,
    scheduleKind: fields.scheduleKind,
    allDay: fields.allDay,
    dueDate: fields.dueDate,
    dueAt: fields.dueAt === null ? null : new Date(fields.dueAt),
    rrule: fields.rrule,
    intervalAfterCompletionDays: fields.intervalAfterCompletionDays,
    workingDaysOnly: fields.workingDaysOnly,
    remindOffsetDays: fields.remindOffsetDays,
    leadTimeDays: fields.leadTimeDays,
    reminderProfile: fields.reminderProfile,
    assignmentMode: fields.assignmentMode,
  };
}
