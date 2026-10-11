import { z } from 'zod';

/**
 * Request and response shapes of the tasks and occurrences API, shared by the api, the worker
 * and the web app. The enums mirror the Postgres enums in `@tracker/db` exactly.
 */

export const SCHEDULE_KINDS = ['once', 'fixed', 'after_completion'] as const;
export const REMINDER_SLOTS = ['evening', 'morning', 'custom_time'] as const;
export const REMINDER_PROFILES = ['silent', 'gentle', 'standard', 'persistent'] as const;
export const ASSIGNMENT_MODES = ['fixed', 'any', 'rotation'] as const;
export const OCCURRENCE_STATUSES = ['upcoming', 'active', 'started', 'done', 'skipped'] as const;

export const scheduleKindSchema = z.enum(SCHEDULE_KINDS);
export const reminderSlotSchema = z.enum(REMINDER_SLOTS);
export const reminderProfileSchema = z.enum(REMINDER_PROFILES);
export const assignmentModeSchema = z.enum(ASSIGNMENT_MODES);
export const occurrenceStatusSchema = z.enum(OCCURRENCE_STATUSES);

export type ScheduleKind = z.infer<typeof scheduleKindSchema>;
export type ReminderSlot = z.infer<typeof reminderSlotSchema>;
export type ReminderProfile = z.infer<typeof reminderProfileSchema>;
export type AssignmentMode = z.infer<typeof assignmentModeSchema>;
export type OccurrenceStatus = z.infer<typeof occurrenceStatusSchema>;

/** The statuses in which an occurrence can still be completed, skipped or snoozed. */
export const OPEN_OCCURRENCE_STATUSES = ['upcoming', 'active', 'started'] as const;

/** `HH:MM`, 24-hour clock. */
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');

/** A real calendar date as `YYYY-MM-DD`. */
export const calendarDateSchema = z.iso.date();

/** An ISO 8601 date-time with a `Z` or numeric UTC offset, such as `2026-07-01T09:30:00+01:00`. */
const instantSchema = z.iso.datetime({ offset: true });

const MAX_ASSIGNEES = 20;
const MAX_MILESTONES = 20;
const MAX_DAYS = 3650;

export const milestoneInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  offsetDaysBeforeDue: z.number().int().min(0).max(MAX_DAYS),
});

/**
 * Task fields as the api accepts them, with no defaults and no cross-field rules, so the body
 * schema (defaults and rules added) and the patch schema (everything optional) share one source.
 * Nullable fields also accept `null`, so a task read from the api can be sent back unchanged.
 */
const taskFieldsObject = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(10_000),
  category: z.string().trim().min(1).max(60).nullish(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  priority: z.number().int().min(0).max(3),
  reminderSlot: reminderSlotSchema,
  /** Required when `reminderSlot` is `custom_time`; ignored (stored as null) otherwise. */
  reminderCustomTime: timeOfDaySchema.nullish(),
  effortMinutes: z.number().int().min(1).max(1440).nullish(),
  scheduleKind: scheduleKindSchema,
  /** True (the default) for a date-only due (`dueDate`), false for a timed one (`dueAt`). */
  allDay: z.boolean(),
  dueDate: calendarDateSchema.nullish(),
  dueAt: instantSchema.nullish(),
  /** Required for `fixed` tasks, forbidden otherwise. Its semantics are checked by the api. */
  rrule: z.string().max(500).nullish(),
  /** Required for `after_completion` tasks, forbidden otherwise. */
  intervalAfterCompletionDays: z.number().int().min(1).max(MAX_DAYS).nullish(),
  leadTimeDays: z.number().int().min(0).max(MAX_DAYS).nullish(),
  /** Defaults to the household's default reminder profile, applied by the api. */
  reminderProfile: reminderProfileSchema,
  assignmentMode: assignmentModeSchema,
  /** Members in rotation order. Replaces the whole list when sent in a patch. */
  assigneeIds: z
    .array(z.uuid())
    .max(MAX_ASSIGNEES)
    .refine((ids) => new Set(ids).size === ids.length, 'assigneeIds must be unique'),
  /** Replaces the whole list when sent in a patch. */
  milestones: z.array(milestoneInputSchema).max(MAX_MILESTONES),
});

/** The fields `taskFieldsIssues` looks at. `undefined` and `null` both mean "not set". */
export interface TaskCrossFieldInput {
  scheduleKind: ScheduleKind;
  allDay: boolean;
  dueDate?: string | null | undefined;
  dueAt?: string | null | undefined;
  rrule?: string | null | undefined;
  intervalAfterCompletionDays?: number | null | undefined;
  reminderSlot: ReminderSlot;
  reminderCustomTime?: string | null | undefined;
}

export interface TaskFieldIssue {
  path: [field: keyof TaskCrossFieldInput];
  message: string;
}

/**
 * The cross-field rules of a task, as a list of problems (empty when valid):
 * - an all-day task has `dueDate` and no `dueAt`; a timed task (`allDay: false`) has `dueAt`
 *   and no `dueDate`;
 * - `fixed` and `after_completion` tasks need a first due; a `once` task may be undated;
 * - `rrule` is required for `fixed` and forbidden otherwise;
 * - `intervalAfterCompletionDays` is required for `after_completion` and forbidden otherwise;
 * - `reminderCustomTime` is required for the `custom_time` slot.
 *
 * `taskBodySchema` applies these; the api also calls it on a stored task merged with a patch.
 */
export function taskFieldsIssues(fields: TaskCrossFieldInput): TaskFieldIssue[] {
  const issues: TaskFieldIssue[] = [];
  const issue = (field: TaskFieldIssue['path'][0], message: string): void => {
    issues.push({ path: [field], message });
  };
  const has = (value: unknown): boolean => value !== undefined && value !== null;

  if (fields.allDay) {
    if (has(fields.dueAt)) issue('dueAt', 'dueAt is only for timed tasks; set allDay to false');
    if (!has(fields.dueDate) && fields.scheduleKind !== 'once') {
      issue('dueDate', `dueDate is required for a ${fields.scheduleKind} task`);
    }
  } else {
    if (has(fields.dueDate)) issue('dueDate', 'dueDate is only for all-day tasks');
    if (!has(fields.dueAt)) issue('dueAt', 'dueAt is required when allDay is false');
  }

  if (fields.scheduleKind === 'fixed') {
    if (!has(fields.rrule)) issue('rrule', 'rrule is required for a fixed task');
  } else if (has(fields.rrule)) {
    issue('rrule', 'rrule is only for fixed tasks');
  }

  if (fields.scheduleKind === 'after_completion') {
    if (!has(fields.intervalAfterCompletionDays)) {
      issue(
        'intervalAfterCompletionDays',
        'intervalAfterCompletionDays is required for an after_completion task',
      );
    }
  } else if (has(fields.intervalAfterCompletionDays)) {
    issue(
      'intervalAfterCompletionDays',
      'intervalAfterCompletionDays is only for after_completion tasks',
    );
  }

  if (fields.reminderSlot === 'custom_time' && !has(fields.reminderCustomTime)) {
    issue('reminderCustomTime', 'reminderCustomTime is required for the custom_time slot');
  }

  return issues;
}

/** Body of `POST /api/tasks`. */
export const taskBodySchema = taskFieldsObject
  .extend({
    notes: taskFieldsObject.shape.notes.default(''),
    tags: taskFieldsObject.shape.tags.default([]),
    priority: taskFieldsObject.shape.priority.default(0),
    reminderSlot: taskFieldsObject.shape.reminderSlot.default('evening'),
    allDay: taskFieldsObject.shape.allDay.default(true),
    reminderProfile: taskFieldsObject.shape.reminderProfile.optional(),
    assignmentMode: taskFieldsObject.shape.assignmentMode.default('fixed'),
    assigneeIds: taskFieldsObject.shape.assigneeIds.default([]),
    milestones: taskFieldsObject.shape.milestones.default([]),
  })
  .superRefine((fields, ctx) => {
    for (const { path, message } of taskFieldsIssues(fields)) {
      ctx.addIssue({ code: 'custom', path, message });
    }
  });

/**
 * Body of `PATCH /api/tasks/:id`: every field optional (`null` clears a nullable one). The cross-
 * field rules cannot be checked on a patch alone, so the api merges it onto the stored task and
 * validates the result with `taskBodySchema` (or `taskFieldsIssues`).
 */
export const taskPatchSchema = taskFieldsObject.extend({ archived: z.boolean() }).partial();

/** The fields of `taskPatchSchema` that change when a task is rescheduled. */
export const TASK_SCHEDULE_FIELDS = [
  'scheduleKind',
  'allDay',
  'dueDate',
  'dueAt',
  'rrule',
  'intervalAfterCompletionDays',
  'leadTimeDays',
] as const;

export const taskListQuerySchema = z.object({
  /** Include archived tasks instead of active ones (default `false`). */
  archived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const milestoneSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  offsetDaysBeforeDue: z.number().int(),
});

export const taskSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  notes: z.string(),
  category: z.string().nullable(),
  tags: z.array(z.string()),
  priority: z.number().int(),
  reminderSlot: reminderSlotSchema,
  reminderCustomTime: timeOfDaySchema.nullable(),
  effortMinutes: z.number().int().nullable(),
  scheduleKind: scheduleKindSchema,
  allDay: z.boolean(),
  dueDate: z.string().nullable(),
  dueAt: z.iso.datetime().nullable(),
  rrule: z.string().nullable(),
  intervalAfterCompletionDays: z.number().int().nullable(),
  leadTimeDays: z.number().int().nullable(),
  reminderProfile: reminderProfileSchema,
  assignmentMode: assignmentModeSchema,
  /** Members in rotation order. */
  assigneeIds: z.array(z.uuid()),
  /**
   * Who has the task's earliest open (upcoming, active or started) occurrence, the due-first
   * one, undated last. `null` when it has no open occurrence or that one is unassigned.
   */
  nextAssigneeId: z.uuid().nullable(),
  /** Ordered by position. */
  milestones: z.array(milestoneSchema),
  archived: z.boolean(),
  archivedAt: z.iso.datetime().nullable(),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const taskResponseSchema = z.object({ task: taskSchema });
export const tasksResponseSchema = z.object({ tasks: z.array(taskSchema) });

export const occurrenceSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  task: z.object({
    title: z.string(),
    category: z.string().nullable(),
    priority: z.number().int(),
    allDay: z.boolean(),
    scheduleKind: scheduleKindSchema,
  }),
  dueDate: z.string().nullable(),
  dueAt: z.iso.datetime().nullable(),
  startAt: z.iso.datetime().nullable(),
  assigneeId: z.uuid().nullable(),
  status: occurrenceStatusSchema,
  completedAt: z.iso.datetime().nullable(),
  completedBy: z.uuid().nullable(),
  snoozedUntil: z.iso.datetime().nullable(),
  /** Computed when the response is built: past its due and still open. */
  overdue: z.boolean(),
});

export const occurrenceResponseSchema = z.object({ occurrence: occurrenceSchema });
export const occurrencesResponseSchema = z.object({ occurrences: z.array(occurrenceSchema) });

/** Response of completing or skipping: `next` is the occurrence that was created, if any. */
export const occurrenceCompletionResponseSchema = z.object({
  occurrence: occurrenceSchema,
  next: occurrenceSchema.nullable(),
});

export const OCCURRENCE_VIEWS = ['today', 'upcoming', 'overdue'] as const;

/** Query of `GET /api/occurrences`. */
export const occurrenceListQuerySchema = z.object({
  view: z.enum(OCCURRENCE_VIEWS).default('today'),
  /** Only occurrences assigned to this member. */
  memberId: z.uuid().optional(),
  taskId: z.uuid().optional(),
  /** How far ahead the `upcoming` view looks. */
  days: z.coerce.number().int().min(1).max(366).default(30),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** Body of `POST /api/occurrences/:id/snooze`: exactly one of an end time or a number of days. */
export const snoozeBodySchema = z.union([
  z.strictObject({ until: instantSchema }),
  z.strictObject({ days: z.number().int().min(1).max(365) }),
]);

export type MilestoneInput = z.infer<typeof milestoneInputSchema>;
export type TaskBody = z.infer<typeof taskBodySchema>;
export type TaskPatch = z.infer<typeof taskPatchSchema>;
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
export type MilestoneDto = z.infer<typeof milestoneSchema>;
export type TaskDto = z.infer<typeof taskSchema>;
export type OccurrenceDto = z.infer<typeof occurrenceSchema>;
export type OccurrenceView = (typeof OCCURRENCE_VIEWS)[number];
export type OccurrenceListQuery = z.infer<typeof occurrenceListQuerySchema>;
export type SnoozeBody = z.infer<typeof snoozeBodySchema>;
