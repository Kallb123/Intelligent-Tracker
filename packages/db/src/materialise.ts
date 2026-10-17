import {
  localToday,
  dueFromKey,
  dueLocalDate,
  dueKey,
  onWorkingDay,
  occurrencesToMaterialise,
  RecurrenceError,
  scheduleFromTask,
  startOfLocalDay,
  startAtFor,
  type Due,
  type MaterialisedDue,
} from '@tracker/core';
import {
  and,
  arrayOverlaps,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import type { DbOrTransaction } from './client.js';
import { dueInstant, dueOf } from './due.js';
import { assigneeIdsOf, replanRotation } from './rotation.js';
import { bankHoliday, household, occurrence, task } from './schema/index.js';
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
  const due = dueOf(row);
  // An undated occurrence has no due to anchor to, so the schedule's own start applies.
  return due ? { completedAt: row.completedAt, due } : undefined;
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
  options: { now: Date; additionalDues?: readonly Due[] },
): Promise<MaterialiseTaskResult> {
  const { now } = options;
  const [row] = await db
    .select({ task, timezone: household.timezone, region: household.bankHolidayRegion })
    .from(task)
    .innerJoin(household, eq(household.id, task.householdId))
    .where(eq(task.id, taskId))
    // Task first, then its occurrences, as in every other writer (see rotation.ts).
    .for('no key update', { of: task });
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
  const kept = (options.additionalDues ?? []).map((due) => ({
    due,
    startAt: startAtFor(due, t.leadTimeDays, { timezone }),
  }));
  const assigneeId = assigneeFor(t.assignmentMode, await assigneeIdsOf(db, t.id));
  const holidays = t.workingDaysOnly
    ? new Set(
        (
          await db
            .select({ date: bankHoliday.date })
            .from(bankHoliday)
            .where(eq(bankHoliday.region, row.region))
        ).map((h) => h.date),
      )
    : new Set<string>();
  const grouped = new Map<string, { planned: MaterialisedDue; sources: Set<string> }>();
  const today = localToday(now, timezone);
  const seen = new Set<string>();
  for (const [p, notBefore] of [
    // Kept dues first: a re-planned due is never shifted back into the past, where nobody saw it
    // coming, and each source date belongs to one occurrence only.
    ...kept.map((p) => [p, today] as const),
    ...planned.map((p) => [p, undefined] as const),
  ]) {
    const source = dueKey(p.due);
    if (seen.has(source)) continue;
    seen.add(source);
    const shifted = t.workingDaysOnly ? onWorkingDay(p, holidays, timezone, notBefore) : p;
    const key = dueKey(shifted.due);
    const group = grouped.get(key) ?? { planned: shifted, sources: new Set<string>() };
    group.sources.add(source);
    grouped.set(key, group);
  }
  // Only rows that already cover one of these dues, not the task's whole history.
  const groups = [...grouped.values()];
  const dues = groups.map((g) => g.planned.due);
  const dueDates = dues.flatMap((due) => (due.allDay ? [due.date] : []));
  const dueAts = dues.flatMap((due) => (due.allDay ? [] : [due.at]));
  const existing = groups.length
    ? await db
        .select({
          id: occurrence.id,
          dueDate: occurrence.dueDate,
          dueAt: occurrence.dueAt,
          sourceDueKeys: occurrence.sourceDueKeys,
        })
        .from(occurrence)
        .where(
          and(
            eq(occurrence.taskId, t.id),
            or(
              arrayOverlaps(
                occurrence.sourceDueKeys,
                groups.flatMap((g) => [...g.sources]),
              ),
              dueDates.length ? inArray(occurrence.dueDate, dueDates) : undefined,
              dueAts.length ? inArray(occurrence.dueAt, dueAts) : undefined,
            ),
          ),
        )
    : [];
  const covered = new Set(existing.flatMap((o) => o.sourceDueKeys));
  const byDue = new Map(
    existing.flatMap((o) => {
      const due = dueOf(o);
      return due ? [[dueKey(due), o] as const] : [];
    }),
  );
  const rows: NewOccurrence[] = [];
  for (const [key, group] of grouped) {
    const sources = [...group.sources].filter((source) => !covered.has(source));
    if (sources.length === 0) continue;
    const stored = byDue.get(key);
    if (stored) {
      // A horizon may grow to include another source date that coalesces into an existing due.
      await db
        .update(occurrence)
        .set({ sourceDueKeys: [...new Set([...stored.sourceDueKeys, ...sources])] })
        .where(eq(occurrence.id, stored.id));
    } else {
      rows.push({
        ...occurrenceRow(t.id, assigneeId, now, timezone, group.planned),
        sourceDueKeys: sources,
      });
    }
  }
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
 * Runs `materialiseTask` for every non-archived task in every household, in `task.id` order. A task whose schedule
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
    // A fixed order, so tasks are locked in the same order by every writer that locks several.
    .orderBy(asc(task.id));
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
 * else the due instant (an all-day due counts from local midnight in the household's time zone),
 * else (undated) immediately. Returns how many changed. Idempotent.
 *
 * Like every writer it locks the tasks involved before their occurrences, in id order (see
 * rotation.ts); the condition is checked again once they are locked.
 */
export async function activateDue(db: DbOrTransaction, options: { now: Date }): Promise<number> {
  const now = sql`${options.now.toISOString()}::timestamptz`;
  const ready = and(
    eq(occurrence.taskId, task.id),
    eq(occurrence.status, 'upcoming'),
    or(
      sql`${occurrence.startAt} <= ${now}`,
      and(
        isNull(occurrence.startAt),
        or(
          sql`${dueInstant(household.timezone)} <= ${now}`,
          and(isNull(occurrence.dueAt), isNull(occurrence.dueDate)),
        ),
      ),
    ),
  );

  const tasks = await db
    .select({ id: task.id })
    .from(occurrence)
    .innerJoin(task, eq(task.id, occurrence.taskId))
    .innerJoin(household, eq(household.id, task.householdId))
    .where(ready)
    .groupBy(task.id)
    .orderBy(asc(task.id));
  if (tasks.length === 0) return 0;
  const taskIds = tasks.map((t) => t.id);
  await db
    .select({ id: task.id })
    .from(task)
    .where(inArray(task.id, taskIds))
    .orderBy(asc(task.id))
    .for('no key update');

  const rows = await db
    .update(occurrence)
    .set({ status: 'active' })
    .from(task)
    .innerJoin(household, eq(household.id, task.householdId))
    // Only the tasks locked above; anything that became ready since waits for the next tick.
    .where(and(ready, inArray(task.id, taskIds)))
    .returning({ id: occurrence.id });
  return rows.length;
}

/**
 * Deletes the task's `upcoming` and `active` occurrences that are due today (household-local) or
 * later, or undated, so a changed schedule can be materialised afresh. Occurrences already
 * started, done or skipped, and overdue ones from before today, are kept. With `touchingDates`,
 * only occurrences whose span from earliest source date to due includes one of those local
 * dates are deleted (the ones a bank-holiday change can move). Returns the number deleted and
 * the recurrence dates they covered.
 */
export async function clearFutureOpenOccurrences(
  db: DbOrTransaction,
  taskId: string,
  options: { now: Date; touchingDates?: ReadonlySet<string> },
): Promise<{ deleted: number; sourceDueKeys: string[] }> {
  const [row] = await db
    .select({ timezone: household.timezone })
    .from(task)
    .innerJoin(household, eq(household.id, task.householdId))
    .where(eq(task.id, taskId));
  if (!row) return { deleted: 0, sourceDueKeys: [] };
  const { timezone } = row;
  const today = localToday(options.now, timezone);
  const candidates = await db
    .select({
      id: occurrence.id,
      sourceDueKeys: occurrence.sourceDueKeys,
      dueDate: occurrence.dueDate,
      dueAt: occurrence.dueAt,
    })
    .from(occurrence)
    .where(
      and(
        eq(occurrence.taskId, taskId),
        inArray(occurrence.status, OPEN_NOT_STARTED),
        or(
          gte(occurrence.dueDate, today),
          gte(occurrence.dueAt, startOfLocalDay(today, timezone)),
          and(isNull(occurrence.dueDate), isNull(occurrence.dueAt)),
        ),
      ),
    );
  const cleared = candidates.flatMap((o) => {
    const due = dueOf(o);
    const sourceDueKeys = o.sourceDueKeys.length ? o.sourceDueKeys : due ? [dueKey(due)] : [];
    if (options.touchingDates) {
      if (!due) return [];
      const end = dueLocalDate(due, timezone);
      const start =
        sourceDueKeys.map((key) => dueLocalDate(dueFromKey(key), timezone)).sort()[0] ?? end;
      if (![...options.touchingDates].some((date) => date >= start && date <= end)) return [];
    }
    return [{ id: o.id, sourceDueKeys }];
  });
  if (cleared.length) {
    // Re-check the status, in case a caller did not lock the task before clearing.
    await db.delete(occurrence).where(
      and(
        inArray(
          occurrence.id,
          cleared.map((o) => o.id),
        ),
        inArray(occurrence.status, OPEN_NOT_STARTED),
      ),
    );
  }
  return { deleted: cleared.length, sourceDueKeys: cleared.flatMap((o) => o.sourceDueKeys) };
}

/**
 * Clears the task's future open occurrences (see `clearFutureOpenOccurrences`) and materialises
 * it again. `keepDues` plans the cleared recurrence dates again, for changes that move dues
 * without changing the recurrence (lead time, working days, bank holidays); without it only the
 * task's current schedule decides.
 */
export async function rematerialiseTask(
  db: DbOrTransaction,
  taskId: string,
  options: { now: Date; keepDues: boolean; touchingDates?: ReadonlySet<string> },
): Promise<MaterialiseTaskResult> {
  const cleared = await clearFutureOpenOccurrences(db, taskId, options);
  return materialiseTask(db, taskId, {
    now: options.now,
    additionalDues: options.keepDues ? cleared.sourceDueKeys.map(dueFromKey) : [],
  });
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
