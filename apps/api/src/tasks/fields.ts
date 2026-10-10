import { RecurrenceError, scheduleFromTask } from '@tracker/core';
import type { NewTask } from '@tracker/db';
import type { MilestoneInput, ReminderProfile, TaskBody, TaskDto } from '@tracker/shared';
import { AppError } from '../errors.js';

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
  leadTimeDays: number | null;
  reminderProfile: ReminderProfile;
  assignmentMode: TaskBody['assignmentMode'];
  assigneeIds: string[];
  milestones: MilestoneInput[];
}

/** The editable fields of a task as the api returned it, for merging a patch onto. */
export function fieldsOfDto(dto: TaskDto): TaskFieldValues {
  return {
    title: dto.title,
    notes: dto.notes,
    category: dto.category,
    tags: dto.tags,
    priority: dto.priority,
    reminderSlot: dto.reminderSlot,
    reminderCustomTime: dto.reminderCustomTime,
    effortMinutes: dto.effortMinutes,
    scheduleKind: dto.scheduleKind,
    allDay: dto.allDay,
    dueDate: dto.dueDate,
    dueAt: dto.dueAt,
    rrule: dto.rrule,
    intervalAfterCompletionDays: dto.intervalAfterCompletionDays,
    leadTimeDays: dto.leadTimeDays,
    reminderProfile: dto.reminderProfile,
    assignmentMode: dto.assignmentMode,
    assigneeIds: dto.assigneeIds,
    milestones: dto.milestones.map((m) => ({
      title: m.title,
      offsetDaysBeforeDue: m.offsetDaysBeforeDue,
    })),
  };
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
    leadTimeDays: body.leadTimeDays ?? null,
    reminderProfile: body.reminderProfile ?? defaultProfile,
    assignmentMode: body.assignmentMode,
    assigneeIds: body.assigneeIds,
    milestones: body.milestones,
  };
}

/** The `task` row columns for these fields (not the assignees and milestones, which are tables). */
export function taskColumns(
  fields: TaskFieldValues,
): Omit<NewTask, 'householdId' | 'createdBy' | 'id'> {
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
    leadTimeDays: fields.leadTimeDays,
    reminderProfile: fields.reminderProfile,
    assignmentMode: fields.assignmentMode,
  };
}

/** The names of the fields whose values differ between two normalised tasks. */
export function changedFields(before: TaskFieldValues, after: TaskFieldValues): string[] {
  return (Object.keys(after) as (keyof TaskFieldValues)[]).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

/** Runs `fn`, turning a `RecurrenceError` (a schedule that cannot be materialised) into a 400. */
export async function withScheduleErrors<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RecurrenceError) throw new AppError(400, 'invalid_schedule', err.message);
    throw err;
  }
}

/** Checks the schedule fields (RRULE semantics, dates, interval) with the recurrence engine. */
export function assertValidSchedule(fields: TaskFieldValues): void {
  scheduleFromTask({
    scheduleKind: fields.scheduleKind,
    allDay: fields.allDay,
    dueDate: fields.dueDate,
    dueAt: fields.dueAt === null ? null : new Date(fields.dueAt),
    rrule: fields.rrule,
    intervalAfterCompletionDays: fields.intervalAfterCompletionDays,
  });
}
