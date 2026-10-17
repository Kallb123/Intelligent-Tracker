import { RecurrenceError, scheduleFromTask } from '@tracker/core';
import type { TaskFieldValues } from '@tracker/db';
import type { TaskDto } from '@tracker/shared';
import { AppError } from '../errors.js';

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
    workingDaysOnly: dto.workingDaysOnly,
    remindOffsetDays: dto.remindOffsetDays,
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
