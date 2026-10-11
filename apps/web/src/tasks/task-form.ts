import {
  previewDates,
  RecurrenceError,
  scheduleFromTask,
  type Due,
  type TaskScheduleFields,
} from '@tracker/core';
import type { AssignmentMode, ReminderProfile, ReminderSlot, TaskDto } from '@tracker/shared';
import type { TaskInput } from '../api/types.js';
import { formatDayHeading } from '../format.js';
import { instantToWall, wallToInstant } from '../wall-time.js';
import {
  buildRecurrence,
  defaultRecurrence,
  parseRecurrence,
  type RecurrenceState,
} from './recurrence-form.js';

/**
 * The task editor's form state, and the mapping between it and the api's task shape. Kept apart
 * from the page so it is unit-tested without a DOM. Inputs are strings or `number | null` (empty)
 * exactly as the controls hold them; `taskBody` turns them into what the api accepts.
 */

export interface MilestoneForm {
  title: string;
  /** Days before the due date; null while the input is empty. */
  days: number | null;
}

export interface TaskForm {
  title: string;
  notes: string;
  category: string;
  /** Comma-separated, as typed. */
  tags: string;
  priority: number;
  effortMinutes: number | null;
  allDay: boolean;
  /** `YYYY-MM-DD` in the household's zone; '' for an undated one-off. */
  dueDate: string;
  /** `HH:MM`, only for a timed task. */
  dueTime: string;
  recurrence: RecurrenceState;
  leadTimeDays: number | null;
  milestones: MilestoneForm[];
  /** '' lets the api use the household's default profile. */
  reminderProfile: ReminderProfile | '';
  reminderSlot: ReminderSlot;
  reminderCustomTime: string;
  assignmentMode: AssignmentMode;
  /** For `fixed`: the one assignee, or '' for nobody in particular. */
  fixedAssignee: string;
  /** For `rotation`: members in turn order. */
  rotation: string[];
}

export const PRIORITY_OPTIONS = [
  { value: 0, label: 'Normal' },
  { value: 1, label: 'Medium' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Urgent' },
] as const;

/** A new task: all-day, due today, once, evening reminders, assigned to whoever is creating it. */
export function newTaskForm(today: string, memberId: string): TaskForm {
  return {
    title: '',
    notes: '',
    category: '',
    tags: '',
    priority: 0,
    effortMinutes: null,
    allDay: true,
    dueDate: today,
    dueTime: '09:00',
    recurrence: defaultRecurrence('once'),
    leadTimeDays: null,
    milestones: [],
    reminderProfile: '',
    reminderSlot: 'evening',
    reminderCustomTime: '19:00',
    assignmentMode: 'fixed',
    fixedAssignee: memberId,
    rotation: [],
  };
}

/** The form for editing a stored task; its RRULE is read back into the builder where possible. */
export function formFromTask(task: TaskDto, timeZone: string): TaskForm {
  const wall = task.dueAt ? instantToWall(task.dueAt, timeZone) : undefined;
  return {
    title: task.title,
    notes: task.notes,
    category: task.category ?? '',
    tags: task.tags.join(', '),
    priority: task.priority,
    effortMinutes: task.effortMinutes,
    allDay: task.allDay,
    dueDate: wall?.date ?? task.dueDate ?? '',
    dueTime: wall?.time ?? '09:00',
    recurrence: parseRecurrence(task),
    leadTimeDays: task.leadTimeDays,
    milestones: task.milestones.map((m) => ({ title: m.title, days: m.offsetDaysBeforeDue })),
    reminderProfile: task.reminderProfile,
    reminderSlot: task.reminderSlot,
    reminderCustomTime: task.reminderCustomTime ?? '19:00',
    assignmentMode: task.assignmentMode,
    fixedAssignee: task.assignmentMode === 'fixed' ? (task.assigneeIds[0] ?? '') : '',
    rotation: task.assignmentMode === 'rotation' ? task.assigneeIds : [],
  };
}

/** "a, b,, a" -> ["a", "b"]: trimmed, no blanks, no repeats. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
    ),
  ];
}

/** A milestone row left completely empty is ignored rather than rejected. */
const isBlank = (m: MilestoneForm): boolean => m.title.trim() === '' && m.days === null;

/** Why the milestones cannot be saved, or undefined when they can. */
export function milestoneProblem(form: TaskForm): string | undefined {
  const bad = form.milestones.some(
    (m) =>
      !isBlank(m) &&
      (m.title.trim() === '' || m.days === null || !Number.isInteger(m.days) || m.days < 0),
  );
  return bad
    ? 'Each milestone needs a name and a whole number of days before the due date'
    : undefined;
}

/**
 * The scheduling columns the form describes, as core reads them. Throws `RecurrenceError` when
 * the repeat settings are incomplete. A missing due date is not an error here (an undated
 * one-off is legitimate); `previewDates` and the api each judge it.
 */
export function scheduleFields(form: TaskForm, timeZone: string): TaskScheduleFields {
  const { scheduleKind, rrule, intervalAfterCompletionDays } = buildRecurrence(form.recurrence);
  if (form.allDay) {
    return {
      scheduleKind,
      rrule,
      intervalAfterCompletionDays,
      allDay: true,
      dueDate: form.dueDate || null,
      dueAt: null,
    };
  }
  const dueAt = wallToInstant(form.dueDate, form.dueTime, timeZone) ?? null;
  return { scheduleKind, rrule, intervalAfterCompletionDays, allDay: false, dueDate: null, dueAt };
}

/** The body for `POST /api/tasks` and (whole, as a patch) `PATCH /api/tasks/:id`. */
export function taskBody(form: TaskForm, timeZone: string): TaskInput {
  const schedule = scheduleFields(form, timeZone);
  const category = form.category.trim();
  const assigneeIds = {
    fixed: form.fixedAssignee ? [form.fixedAssignee] : [],
    any: [],
    rotation: form.rotation,
  }[form.assignmentMode];
  return {
    title: form.title.trim(),
    notes: form.notes,
    category: category === '' ? null : category,
    tags: parseTags(form.tags),
    priority: form.priority,
    effortMinutes: form.effortMinutes,
    reminderSlot: form.reminderSlot,
    reminderCustomTime: form.reminderSlot === 'custom_time' ? form.reminderCustomTime : null,
    scheduleKind: schedule.scheduleKind,
    allDay: schedule.allDay,
    dueDate: schedule.dueDate,
    dueAt: schedule.dueAt ? schedule.dueAt.toISOString() : null,
    rrule: schedule.rrule,
    intervalAfterCompletionDays: schedule.intervalAfterCompletionDays,
    leadTimeDays: form.leadTimeDays,
    ...(form.reminderProfile !== '' && { reminderProfile: form.reminderProfile }),
    assignmentMode: form.assignmentMode,
    assigneeIds,
    milestones: form.milestones
      .filter((m) => !isBlank(m))
      .map((m) => ({ title: m.title.trim(), offsetDaysBeforeDue: m.days ?? 0 })),
  };
}

export type DatesPreview =
  /** `dues` may be empty (a one-off in the past); `note` explains anything unusual. */
  { dues: Due[]; note?: string } | { error: string };

/** How a due is listed in the preview: "Mon 12 Oct 2026", with the time for a timed one. */
export function formatDue(due: Due, timeZone: string): string {
  if (due.allDay) return formatDayHeading(due.date, undefined, true);
  const { date, time } = instantToWall(due.at, timeZone);
  return `${formatDayHeading(date, undefined, true)} at ${time}`;
}

/** What `previewDates` says about a core error, worded for someone filling in the form. */
function friendly(err: RecurrenceError): string {
  return err.code === 'invalid_rrule' || err.code === 'unsupported_rrule'
    ? `That repeat rule cannot be used: ${err.message}`
    : err.message;
}

/**
 * The next `count` dates the form's schedule produces on or after `from`, using the same engine
 * the worker uses, or a friendly error when the schedule is incomplete or invalid.
 */
export function previewSchedule(
  form: TaskForm,
  timeZone: string,
  from: Date,
  count = 5,
): DatesPreview {
  try {
    const fields = scheduleFields(form, timeZone);
    const hasDue = fields.allDay ? fields.dueDate !== null : fields.dueAt !== null;
    if (!hasDue) {
      if (fields.scheduleKind === 'once' && fields.allDay) {
        return {
          dues: [],
          note: 'With no due date this task is always on Today until it is done.',
        };
      }
      return {
        error: fields.allDay
          ? 'Choose a due date to see the next dates.'
          : 'Choose a due date and time to see the next dates.',
      };
    }
    const dues = previewDates(scheduleFromTask(fields), from, count, { timezone: timeZone });
    return fields.scheduleKind === 'after_completion'
      ? { dues, note: 'Later dates are set when each one is completed.' }
      : { dues };
  } catch (err) {
    if (err instanceof RecurrenceError) return { error: friendly(err) };
    throw err;
  }
}
