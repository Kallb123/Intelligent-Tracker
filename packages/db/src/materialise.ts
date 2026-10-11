import {
  localToday,
  occurrencesToMaterialise,
  RecurrenceError,
  scheduleFromTask,
  startOfLocalDay,
  type Due,
  type MaterialisedDue,
} from '@tracker/core';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { DbOrTransaction } from './client.js';
import { assigneeIdsOf, replanRotation } from './rotation.js';
import { household, occurrence, task } from './schema/index.js';
import type { NewOccurrence, Task } from './schema/index.js';

/*
 * Materialisation turns a task (the series) into `occurrence` rows. Everything here is
 * idempotent: the unique constraints on (task, due date), (task, due instant) and the undated
 * index let `INSERT ... ON CONFLICT DO NOTHING` skip rows that already exist, so the worker can
 * run it every tick, the api can run it after every edit, and two of them can race safely.
 *
 * A household's `timezone` decides what "today" and "the start of a day" mean throughout.
 */

export interface MaterialiseTaskResult {
  /** Rows actually inserted; dues that already had an occurrence are not counted. */
  inserted: number;
  /** Ids of the inserted rows (e.g. the `next` occurrence after completing an after_completion task). */
  occurrenceIds: string[];
}

export interface MaterialiseFailure {
  taskId: string;
  /** The `RecurrenceError` code, such as `invalid_rrule`. */
  code: string;
  message: string;
}

export interface MaterialiseAllResult {
  /** Tasks that were looked at (non-archived, in any household). */
  tasks: number;
  inserted: number;
  /** Tasks that could not be materialised; the others were. The caller should log these. */
  failures: MaterialiseFailure[];
}

type OccurrenceStatus = NewOccurrence['status'];

const OPEN_NOT_STARTED = ['upcoming', 'active'] as const satisfies OccurrenceStatus[];
const OPEN = ['upcoming', 'active', 'started'] as const satisfies OccurrenceStatus[];

/**
 * Who a new occurrence of a `fixed` or `any` task is assigned to: the first assignee, or no one
 * for `any`. A `rotation` task's occurrences start unassigned and are planned right after (see
 * `replanRotation`).
 */
function assigneeFor(mode: Task['assignmentMode'], assigneeIds: string[]): string | null {
  return mode === 'fixed' ? (assigneeIds[0] ?? null) : null;
}

/** The instant an occurrence becomes active: its `startAt`, else its due, else immediately. */
function activeFrom({ due, startAt }: MaterialisedDue, timezone: string): Date | null {
  if (startAt !== null) return startAt;
  if (due.allDay) return startOfLocalDay(due.date, timezone);
  return due.at;
}

function occurrenceRow(
  taskId: string,
  assigneeId: string | null,
  now: Date,
  timezone: string,
  planned: MaterialisedDue | null,
): NewOccurrence {
  // An undated occurrence (`planned` null) is active straight away.
  const from = planned === null ? null : activeFrom(planned, timezone);
  const status: OccurrenceStatus = from === null || from <= now ? 'active' : 'upcoming';
  const due = planned?.due;
  return {
    taskId,
    dueDate: due?.allDay ? due.date : null,
    dueAt: due && !due.allDay ? due.at : null,
    startAt: planned?.startAt ?? null,
    assigneeId,
    status,
  };
}

/** The due of the occurrence that was completed (or skipped) last, for `after_completion`. */
async function lastCompletedOf(
  db: DbOrTransaction,
  taskId: string,
): Promise<{ completedAt: Date; due: Due } | undefined> {
  const [row] = await db
    .select({
      completedAt: occurrence.completedAt,
      dueDate: occurrence.dueDate,
      dueAt: occurrence.dueAt,
    })
    .from(occurrence)
    .where(
      and(
        eq(occurrence.taskId, taskId),
        inArray(occurrence.status, ['done', 'skipped']),
        isNotNull(occurrence.completedAt),
      ),
    )
    .orderBy(desc(occurrence.completedAt))
    .limit(1);
  if (!row?.completedAt) return undefined;
  if (row.dueAt) return { completedAt: row.completedAt, due: { allDay: false, at: row.dueAt } };
  if (row.dueDate)
    return { completedAt: row.completedAt, due: { allDay: true, date: row.dueDate } };
  // An undated occurrence has no due to anchor to, so the schedule's own start applies.
  return undefined;
}

async function hasOpenOccurrence(db: DbOrTransaction, taskId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: occurrence.id })
    .from(occurrence)
    .where(and(eq(occurrence.taskId, taskId), inArray(occurrence.status, OPEN)))
    .limit(1);
  return row !== undefined;
}

/**
 * Makes sure the task has the occurrences it should have at `now` (see core's
 * `occurrencesToMaterialise`): a `fixed` task gets every due from today to the horizon, a `once`
 * task its single (possibly undated) occurrence, an `after_completion` task exactly one open
 * occurrence. Existing rows are left alone, so calling it again changes nothing. Archived or
 * missing tasks are skipped. Throws `RecurrenceError` if the task's schedule is invalid.
 *
 * For a `rotation` task the new rows are handed to the assignees in turn (`replanRotation`).
 *
 * New occurrences start `active` when their start (`startAt`, else the due, else immediately) has
 * arrived and `upcoming` otherwise; the worker's `activateDue` promotes the latter later.
 */
export async function materialiseTask(
  db: DbOrTransaction,
  taskId: string,
  options: { now: Date },
): Promise<MaterialiseTaskResult> {
  const { now } = options;
  const [row] = await db
    .select({ task, timezone: household.timezone })
    .from(task)
    .innerJoin(household, eq(household.id, task.householdId))
    .where(eq(task.id, taskId));
  if (!row || row.task.archivedAt !== null) return { inserted: 0, occurrenceIds: [] };
  const { task: t, timezone } = row;

  const schedule = scheduleFromTask(t);
  let lastCompleted: { completedAt: Date; due: Due } | undefined;
  if (schedule.kind === 'after_completion') {
    // The next one is only created once the previous is closed.
    if (await hasOpenOccurrence(db, t.id)) return { inserted: 0, occurrenceIds: [] };
    lastCompleted = await lastCompletedOf(db, t.id);
  }

  const planned = occurrencesToMaterialise(schedule, {
    now,
    leadTimeDays: t.leadTimeDays,
    timezone,
    lastCompleted,
  });
  const assigneeId = assigneeFor(t.assignmentMode, await assigneeIdsOf(db, t.id));
  const rows = planned.map((p) => occurrenceRow(t.id, assigneeId, now, timezone, p));
  // An undated one-off task has nothing to plan but still needs its one occurrence.
  if (schedule.kind === 'once' && schedule.due === null) {
    rows.push(occurrenceRow(t.id, assigneeId, now, timezone, null));
  }
  if (rows.length === 0) return { inserted: 0, occurrenceIds: [] };

  const inserted = await db
    .insert(occurrence)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: occurrence.id });
  if (t.assignmentMode === 'rotation' && inserted.length > 0) {
    await replanRotation(db, t.id, { now });
  }
  return { inserted: inserted.length, occurrenceIds: inserted.map((r) => r.id) };
}

/**
 * Runs `materialiseTask` for every non-archived task in every household. A task whose schedule
 * is broken (`RecurrenceError`) does not stop the rest: it is reported in `failures` for the
 * caller to log. Any other error (such as the database going away) is thrown.
 */
export async function materialiseAll(
  db: DbOrTransaction,
  options: { now: Date },
): Promise<MaterialiseAllResult> {
  const tasks = await db
    .select({ id: task.id })
    .from(task)
    .where(isNull(task.archivedAt))
    .orderBy(asc(task.createdAt), asc(task.id));
  const result: MaterialiseAllResult = { tasks: tasks.length, inserted: 0, failures: [] };
  for (const { id } of tasks) {
    try {
      result.inserted += (await materialiseTask(db, id, options)).inserted;
    } catch (error) {
      if (!(error instanceof RecurrenceError)) throw error;
      result.failures.push({ taskId: id, code: error.code, message: error.message });
    }
  }
  return result;
}

/**
 * Promotes `upcoming` occurrences to `active` once their start has arrived: `startAt` if set,
 * else the due instant, else local midnight at the start of the due date in the household's
 * time zone, else (undated) immediately. Returns how many changed. Idempotent.
 */
export async function activateDue(db: DbOrTransaction, options: { now: Date }): Promise<number> {
  const now = sql`${options.now.toISOString()}::timestamptz`;
  const rows = await db
    .update(occurrence)
    .set({ status: 'active' })
    .from(task)
    .innerJoin(household, eq(household.id, task.householdId))
    .where(
      and(
        eq(occurrence.taskId, task.id),
        eq(occurrence.status, 'upcoming'),
        or(
          sql`${occurrence.startAt} <= ${now}`,
          and(isNull(occurrence.startAt), sql`${occurrence.dueAt} <= ${now}`),
          and(
            isNull(occurrence.startAt),
            sql`(${occurrence.dueDate}::timestamp AT TIME ZONE ${household.timezone}) <= ${now}`,
          ),
          and(isNull(occurrence.startAt), isNull(occurrence.dueAt), isNull(occurrence.dueDate)),
        ),
      ),
    )
    .returning({ id: occurrence.id });
  return rows.length;
}

/**
 * Deletes the task's `upcoming` and `active` occurrences that are due today (household-local) or
 * later, or undated, so a changed schedule can be materialised afresh. Occurrences already
 * started, done or skipped, and overdue ones from before today, are kept. Returns the number
 * deleted.
 */
export async function clearFutureOpenOccurrences(
  db: DbOrTransaction,
  taskId: string,
  options: { now: Date },
): Promise<{ deleted: number }> {
  const [row] = await db
    .select({ timezone: household.timezone })
    .from(task)
    .innerJoin(household, eq(household.id, task.householdId))
    .where(eq(task.id, taskId));
  if (!row) return { deleted: 0 };
  const today = localToday(options.now, row.timezone);
  const rows = await db
    .delete(occurrence)
    .where(
      and(
        eq(occurrence.taskId, taskId),
        inArray(occurrence.status, OPEN_NOT_STARTED),
        or(
          gte(occurrence.dueDate, today),
          gte(occurrence.dueAt, startOfLocalDay(today, row.timezone)),
          and(isNull(occurrence.dueDate), isNull(occurrence.dueAt)),
        ),
      ),
    )
    .returning({ id: occurrence.id });
  return { deleted: rows.length };
}

/**
 * Re-applies the assignment rule to the task's `upcoming` and `active` occurrences, for when its
 * assignees or mode change: the first assignee for `fixed`, no one for `any`, and for `rotation`
 * a fresh plan from the task's cursor (see `replanRotation`). Started occurrences keep whoever
 * is doing them. Returns the number of rows updated.
 */
export async function reassignOpenOccurrences(
  db: DbOrTransaction,
  taskId: string,
  options: { now: Date },
): Promise<{ updated: number }> {
  const [t] = await db
    .select({ assignmentMode: task.assignmentMode })
    .from(task)
    .where(eq(task.id, taskId));
  if (!t) return { updated: 0 };
  if (t.assignmentMode === 'rotation') return replanRotation(db, taskId, options);
  const assigneeId = assigneeFor(t.assignmentMode, await assigneeIdsOf(db, taskId));
  const rows = await db
    .update(occurrence)
    .set({ assigneeId })
    .where(and(eq(occurrence.taskId, taskId), inArray(occurrence.status, OPEN_NOT_STARTED)))
    .returning({ id: occurrence.id });
  return { updated: rows.length };
}
