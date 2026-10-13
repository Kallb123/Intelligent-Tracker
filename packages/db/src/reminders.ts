import {
  planReminders,
  RecurrenceError,
  type Due,
  type PlannedReminder,
  type PlanRemindersInput,
} from '@tracker/core';
import { OPEN_OCCURRENCE_STATUSES, type ReminderPayload } from '@tracker/shared';
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { DbOrTransaction } from './client.js';
import {
  household,
  member,
  notification,
  occurrence,
  reminder,
  task,
  taskMilestone,
} from './schema/index.js';
import type { NewNotification, NewReminder, Reminder, ReminderData } from './schema/index.js';

/*
 * Reminders in the database. The pure planner (core's `planReminders`) says which reminders an
 * occurrence should have; the worker keeps the `reminder` table in step with it every tick:
 *
 *   1. `queueDueReminders`: `planned` reminders whose time has come become `in_app` rows in the
 *      outbox (`notification`) and are marked `sent`. This runs first, because the planner
 *      drops reminders at or before `now`, so the persisted `planned` rows are the record of
 *      what is due. A row may be stale (the occurrence was edited since the last tick), so each
 *      is checked against the planner as it would have planned it just before it fell due, and
 *      only sent if the plan still has it.
 *   2. `replanReminders`: every open occurrence is planned again and its `planned` rows are
 *      brought in line (inserted, moved, cancelled). Any edit, snooze, start, reassignment, away
 *      change or completion is therefore picked up by the next tick, and the overdue horizon
 *      keeps rolling forward.
 *
 * Both are idempotent and safe to repeat or race: `sent` reminders are never touched or re-sent,
 * an unchanged plan writes nothing, and the outbox's unique `dedupe_key` turns a repeated queue
 * into a no-op. The worker runs them in its tick transaction, so a crash rolls back both the
 * outbox rows and the `sent` marks together: nothing is lost and nothing is duplicated.
 */

/**
 * A due reminder older than this is cancelled rather than queued: if the worker was down for
 * longer, an hours-old nag is noise.
 */
export const MISSED_REMINDER_GRACE_MS = 24 * 60 * 60 * 1000;

/** Rows per statement, to stay well below Postgres' limit of 65535 bind parameters. */
const CHUNK = 1000;

function* chunks<T>(items: readonly T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += CHUNK) yield items.slice(i, i + CHUNK);
}

const OPEN = [...OPEN_OCCURRENCE_STATUSES];

export interface QueueRemindersResult {
  /** Reminders marked `sent` (queued in the outbox). */
  queued: number;
  /** Outbox rows inserted: one per recipient. */
  notifications: number;
  /** Reminders cancelled because they were more than `MISSED_REMINDER_GRACE_MS` overdue. */
  cancelled: number;
  /**
   * Occurrences the planner rejected while checking their due reminders; those reminders were
   * left as they were.
   */
  failures: ReminderPlanFailure[];
}

/** The dedupe key of the in-app notification of a reminder for one member. */
export function inAppDedupeKey(reminderId: string, memberId: string): string {
  return `reminder:${reminderId}:in_app:${memberId}`;
}

/**
 * Queues the `planned` reminders that are due (`fire_at <= now`) in the outbox, in the same
 * transaction as marking them `sent`. Reminders more than `MISSED_REMINDER_GRACE_MS` late are
 * cancelled instead. Reminders of an occurrence that is closed, snoozed past `now`, undated or
 * of an archived task are left alone for `replanReminders` to cancel or move.
 *
 * A `planned` row can be out of date: the occurrence may have been reassigned, its assignee put
 * away, snoozed or its task edited since the last re-plan, and this runs before the re-plan. So
 * each fresh due row is checked against the current state by planning its occurrence again with
 * `now` one millisecond before the row's `fire_at` (when the planner would still have listed
 * it), and is queued only if that plan holds the same key at the same time for the same member.
 * Any other row is left `planned` for `replanReminders`, which cancels it (the planner never
 * plans at or before `now`) or moves it.
 *
 * A reminder goes to the occurrence's current assignee alone, or to every member of the
 * household when it has none. That includes an occurrence whose assignee was deleted: the
 * foreign keys set both `occurrence.assignee_id` and `reminder.member_id` to null, which is
 * exactly an unassigned occurrence, and the planner addresses those to the whole household.
 *
 * The due rows are locked (`FOR UPDATE`), so concurrent callers queue each reminder once, and
 * the outbox's `dedupe_key` is a second guard.
 */
export async function queueDueReminders(
  db: DbOrTransaction,
  options: { now: Date },
): Promise<QueueRemindersResult> {
  const { now } = options;
  const result: QueueRemindersResult = { queued: 0, notifications: 0, cancelled: 0, failures: [] };
  const due = await db
    .select({ reminder })
    .from(reminder)
    .innerJoin(occurrence, eq(occurrence.id, reminder.occurrenceId))
    .innerJoin(task, eq(task.id, occurrence.taskId))
    .where(
      and(
        eq(reminder.status, 'planned'),
        lte(reminder.fireAt, now),
        inArray(occurrence.status, OPEN),
        or(isNull(occurrence.snoozedUntil), lte(occurrence.snoozedUntil, now)),
        or(isNotNull(occurrence.dueDate), isNotNull(occurrence.dueAt)),
        isNull(task.archivedAt),
      ),
    )
    .orderBy(asc(reminder.fireAt), asc(reminder.id))
    .for('update', { of: reminder });
  if (due.length === 0) return result;

  const staleBefore = now.getTime() - MISSED_REMINDER_GRACE_MS;
  const stale = due.filter((r) => r.reminder.fireAt.getTime() < staleBefore);
  const fresh = due.filter((r) => r.reminder.fireAt.getTime() >= staleBefore);

  // The current state of every occurrence with a fresh due reminder, for the check below.
  const contexts = await loadPlanContexts(db, [
    ...new Set(fresh.map((r) => r.reminder.occurrenceId)),
  ]);
  const failed = new Set<string>();
  // occurrence id -> key -> the planner's reminder, as planned just before the row fell due.
  const plans = new Map<string, Map<string, PlannedReminder>>();
  const sendable: { reminder: Reminder; context: PlanContext }[] = [];
  for (const { reminder: rem } of fresh) {
    const context = contexts.get(rem.occurrenceId);
    // The row was locked above, but the occurrence may have been deleted meanwhile.
    if (!context || failed.has(rem.occurrenceId)) continue;
    // Planned once per distinct `fire_at`: occurrences usually have one due reminder at a time.
    const planKey = `${rem.occurrenceId}@${rem.fireAt.getTime()}`;
    let plan = plans.get(planKey);
    if (!plan) {
      try {
        plan = new Map(planFor(context, new Date(rem.fireAt.getTime() - 1)).map((p) => [p.key, p]));
      } catch (error) {
        if (!(error instanceof RecurrenceError)) throw error;
        failed.add(rem.occurrenceId);
        result.failures.push(planFailure(context, error));
        continue;
      }
      plans.set(planKey, plan);
    }
    const wanted = plan.get(rem.key);
    if (
      wanted &&
      wanted.fireAt.getTime() === rem.fireAt.getTime() &&
      wanted.memberId === rem.memberId &&
      wanted.memberId === context.occurrence.assigneeId
    ) {
      sendable.push({ reminder: rem, context });
    }
  }

  // Everyone in the households whose unassigned reminders are due.
  const broadcastHouseholds = [
    ...new Set(
      sendable
        .filter((r) => r.context.occurrence.assigneeId === null)
        .map((r) => r.context.task.householdId),
    ),
  ];
  const membersByHousehold = new Map<string, string[]>();
  if (broadcastHouseholds.length > 0) {
    const members = await db
      .select({ id: member.id, householdId: member.householdId })
      .from(member)
      .where(inArray(member.householdId, broadcastHouseholds))
      .orderBy(asc(member.id));
    for (const m of members) {
      membersByHousehold.set(m.householdId, [
        ...(membersByHousehold.get(m.householdId) ?? []),
        m.id,
      ]);
    }
  }

  const outbox: NewNotification[] = [];
  for (const { reminder: rem, context } of sendable) {
    const { occurrence: occ, task: t } = context;
    const payload: ReminderPayload = {
      type: 'reminder',
      kind: rem.kind,
      taskId: t.id,
      occurrenceId: occ.id,
      taskTitle: t.title,
      dueDate: occ.dueDate,
      dueAt: occ.dueAt?.toISOString() ?? null,
      fireAt: rem.fireAt.toISOString(),
      assigneeId: occ.assigneeId,
      ...(rem.data.milestoneTitle !== undefined ? { milestoneTitle: rem.data.milestoneTitle } : {}),
      ...(rem.data.overdueDays !== undefined ? { overdueDays: rem.data.overdueDays } : {}),
    };
    const recipients = occ.assigneeId
      ? [occ.assigneeId]
      : (membersByHousehold.get(t.householdId) ?? []);
    for (const memberId of recipients) {
      outbox.push({
        householdId: t.householdId,
        memberId,
        reminderId: rem.id,
        channel: 'in_app',
        payload,
        dedupeKey: inAppDedupeKey(rem.id, memberId),
        nextAttemptAt: now,
      });
    }
  }

  for (const batch of chunks(outbox)) {
    const inserted = await db
      .insert(notification)
      .values(batch)
      .onConflictDoNothing({ target: notification.dedupeKey })
      .returning({ id: notification.id });
    result.notifications += inserted.length;
  }
  for (const batch of chunks(sendable.map((r) => r.reminder.id))) {
    await db
      .update(reminder)
      .set({ status: 'sent', sentAt: now })
      .where(inArray(reminder.id, batch));
  }
  for (const batch of chunks(stale.map((r) => r.reminder.id))) {
    await db.update(reminder).set({ status: 'cancelled' }).where(inArray(reminder.id, batch));
  }
  result.queued = sendable.length;
  result.cancelled = stale.length;
  return result;
}

export interface ReminderPlanFailure {
  occurrenceId: string;
  taskId: string;
  /** The `RecurrenceError` code, such as `invalid_argument`. */
  code: string;
  message: string;
}

export interface ReplanRemindersResult {
  /** Open occurrences (of non-archived tasks) that were planned. */
  occurrences: number;
  /** Reminder rows inserted or changed (including cancelled ones brought back). */
  planned: number;
  /** `planned` reminders that are no longer wanted and were cancelled. */
  cancelled: number;
  /** Occurrences the planner rejected; their reminders were left as they were. */
  failures: ReminderPlanFailure[];
}

/** An open occurrence with everything `planReminders` needs to plan it. */
interface PlanContext {
  occurrence: typeof occurrence.$inferSelect;
  task: typeof task.$inferSelect;
  household: typeof household.$inferSelect;
  /** The assignee's away date; null when unassigned or not away. */
  awayUntil: string | null;
  milestones: PlanRemindersInput['task']['milestones'][number][];
}

/**
 * Loads the planning context of the given open occurrences of non-archived tasks, or of all of
 * them when no ids are given: three queries however many there are (per chunk of ids). Used by
 * both `replanReminders` and `queueDueReminders`, so the two plan from the same state.
 */
async function loadPlanContexts(
  db: DbOrTransaction,
  occurrenceIds?: readonly string[],
): Promise<Map<string, PlanContext>> {
  const contexts = new Map<string, PlanContext>();
  for (const ids of occurrenceIds ? chunks(occurrenceIds) : [undefined]) {
    const rows = await db
      .select({ occurrence, task, household, awayUntil: member.awayUntil })
      .from(occurrence)
      .innerJoin(task, eq(task.id, occurrence.taskId))
      .innerJoin(household, eq(household.id, task.householdId))
      .leftJoin(member, eq(member.id, occurrence.assigneeId))
      .where(
        and(
          inArray(occurrence.status, OPEN),
          isNull(task.archivedAt),
          ids ? inArray(occurrence.id, ids) : undefined,
        ),
      )
      .orderBy(asc(occurrence.id));
    if (rows.length === 0) continue;

    const taskIds = [...new Set(rows.map((r) => r.task.id))];
    const milestoneRows = await db
      .select()
      .from(taskMilestone)
      .where(inArray(taskMilestone.taskId, taskIds))
      .orderBy(asc(taskMilestone.position));
    const milestonesByTask = new Map<string, PlanContext['milestones']>();
    for (const m of milestoneRows) {
      const list = milestonesByTask.get(m.taskId) ?? [];
      list.push({ id: m.id, title: m.title, offsetDaysBeforeDue: m.offsetDaysBeforeDue });
      milestonesByTask.set(m.taskId, list);
    }
    for (const row of rows) {
      contexts.set(row.occurrence.id, {
        occurrence: row.occurrence,
        task: row.task,
        household: row.household,
        awayUntil: row.awayUntil,
        milestones: milestonesByTask.get(row.task.id) ?? [],
      });
    }
  }
  return contexts;
}

/** The reminders the planner wants for one occurrence at `now`. May throw `RecurrenceError`. */
function planFor(context: PlanContext, now: Date): PlannedReminder[] {
  const { occurrence: occ, task: t, household: h } = context;
  return planReminders({
    occurrence: {
      due: dueOf(occ),
      status: occ.status,
      assigneeId: occ.assigneeId,
      snoozedUntil: occ.snoozedUntil,
      completedMilestoneIds: completedMilestoneIds(occ.milestoneProgress),
    },
    task: {
      leadTimeDays: t.leadTimeDays,
      reminderProfile: t.reminderProfile,
      reminderSlot: t.reminderSlot,
      reminderCustomTime: t.reminderCustomTime,
      milestones: context.milestones,
    },
    assignee: occ.assigneeId === null ? null : { awayUntil: context.awayUntil },
    household: {
      timezone: h.timezone,
      morningSlot: h.morningSlot,
      eveningSlot: h.eveningSlot,
      quietHours: { start: h.quietHoursStart, end: h.quietHoursEnd },
    },
    now,
  });
}

function planFailure(context: PlanContext, error: RecurrenceError): ReminderPlanFailure {
  return {
    occurrenceId: context.occurrence.id,
    taskId: context.task.id,
    code: error.code,
    message: error.message,
  };
}

/**
 * The ids of the milestones ticked off in an occurrence's `milestone_progress`. The column is a
 * JSON object keyed by milestone id; a milestone counts as completed when its value is truthy
 * (for example `true` or the completion timestamp). Nothing writes it yet, so this is the
 * convention the api should follow when it adds ticking milestones.
 */
export function completedMilestoneIds(progress: Record<string, unknown>): string[] {
  return Object.entries(progress)
    .filter(([, done]) => Boolean(done))
    .map(([id]) => id);
}

function dueOf(row: { dueDate: string | null; dueAt: Date | null }): Due | null {
  if (row.dueAt !== null) return { allDay: false, at: row.dueAt };
  if (row.dueDate !== null) return { allDay: true, date: row.dueDate };
  return null;
}

/** The `reminder.data` of a planned reminder. */
function dataOf(planned: PlannedReminder): ReminderData {
  return {
    ...(planned.milestoneId !== undefined ? { milestoneId: planned.milestoneId } : {}),
    ...(planned.milestoneTitle !== undefined ? { milestoneTitle: planned.milestoneTitle } : {}),
    ...(planned.overdueDays !== undefined ? { overdueDays: planned.overdueDays } : {}),
  };
}

function sameData(a: ReminderData, b: ReminderData): boolean {
  return (
    a.milestoneId === b.milestoneId &&
    a.milestoneTitle === b.milestoneTitle &&
    a.overdueDays === b.overdueDays
  );
}

/** Whether the stored `planned` / `cancelled` row differs from what the planner now wants. */
function needsWrite(
  existing: typeof reminder.$inferSelect | undefined,
  want: NewReminder,
): boolean {
  if (!existing) return true;
  if (existing.status === 'sent') return false;
  return (
    existing.status !== 'planned' ||
    existing.kind !== want.kind ||
    existing.memberId !== want.memberId ||
    existing.fireAt.getTime() !== (want.fireAt as Date).getTime() ||
    !sameData(existing.data, want.data ?? {})
  );
}

/**
 * Brings the `reminder` table in line with `planReminders` for every open occurrence of every
 * non-archived task:
 *
 * - a reminder the planner wants and the table lacks is inserted as `planned`;
 * - a `planned` or `cancelled` row whose kind, recipient, time or data differ is updated back to
 *   `planned`; an identical one is left alone, so an idle tick writes nothing;
 * - a `sent` row is never changed (a key is never sent twice);
 * - a `planned` row the planner no longer wants is `cancelled`;
 * - `planned` rows of closed (done, skipped) occurrences and of archived tasks are `cancelled`.
 *
 * Costs a constant number of queries however many occurrences there are. An occurrence the
 * planner rejects (`RecurrenceError`) is reported in `failures` and skipped; any other error is
 * thrown.
 */
export async function replanReminders(
  db: DbOrTransaction,
  options: { now: Date },
): Promise<ReplanRemindersResult> {
  const { now } = options;
  const result: ReplanRemindersResult = { occurrences: 0, planned: 0, cancelled: 0, failures: [] };

  // Closed occurrences and archived tasks: nothing planned should fire any more.
  const closed = await db
    .update(reminder)
    .set({ status: 'cancelled' })
    .from(occurrence)
    .innerJoin(task, eq(task.id, occurrence.taskId))
    .where(
      and(
        eq(reminder.occurrenceId, occurrence.id),
        eq(reminder.status, 'planned'),
        or(notInArray(occurrence.status, OPEN), isNotNull(task.archivedAt)),
      ),
    )
    .returning({ id: reminder.id });
  result.cancelled += closed.length;

  const contexts = await loadPlanContexts(db);
  if (contexts.size === 0) return result;

  const existingRows = await db
    .select({ reminder })
    .from(reminder)
    .innerJoin(occurrence, eq(occurrence.id, reminder.occurrenceId))
    .innerJoin(task, eq(task.id, occurrence.taskId))
    .where(and(inArray(occurrence.status, OPEN), isNull(task.archivedAt)));
  // occurrence id -> key -> stored row.
  const existing = new Map<string, Map<string, typeof reminder.$inferSelect>>();
  for (const { reminder: row } of existingRows) {
    const byKey = existing.get(row.occurrenceId) ?? new Map();
    byKey.set(row.key, row);
    existing.set(row.occurrenceId, byKey);
  }

  const writes: NewReminder[] = [];
  const obsolete: string[] = [];
  for (const context of contexts.values()) {
    const { occurrence: occ } = context;
    let plan: PlannedReminder[];
    try {
      plan = planFor(context, now);
    } catch (error) {
      if (!(error instanceof RecurrenceError)) throw error;
      result.failures.push(planFailure(context, error));
      continue;
    }
    result.occurrences += 1;

    const stored = existing.get(occ.id) ?? new Map<string, typeof reminder.$inferSelect>();
    const wanted = new Set<string>();
    for (const planned of plan) {
      wanted.add(planned.key);
      const want: NewReminder = {
        occurrenceId: occ.id,
        key: planned.key,
        kind: planned.kind,
        memberId: planned.memberId,
        fireAt: planned.fireAt,
        status: 'planned',
        data: dataOf(planned),
      };
      if (needsWrite(stored.get(planned.key), want)) writes.push(want);
    }
    for (const old of stored.values()) {
      if (old.status === 'planned' && !wanted.has(old.key)) obsolete.push(old.id);
    }
  }

  for (const batch of chunks(writes)) {
    const rows = await db
      .insert(reminder)
      .values(batch)
      .onConflictDoUpdate({
        target: [reminder.occurrenceId, reminder.key],
        set: {
          kind: sql`excluded.kind`,
          memberId: sql`excluded.member_id`,
          fireAt: sql`excluded.fire_at`,
          status: 'planned',
          data: sql`excluded.data`,
          updatedAt: now,
        },
        // A reminder queued by a concurrent caller since it was read stays sent.
        setWhere: ne(reminder.status, 'sent'),
      })
      .returning({ id: reminder.id });
    result.planned += rows.length;
  }
  for (const batch of chunks(obsolete)) {
    const rows = await db
      .update(reminder)
      .set({ status: 'cancelled' })
      .where(and(inArray(reminder.id, batch), eq(reminder.status, 'planned')))
      .returning({ id: reminder.id });
    result.cancelled += rows.length;
  }
  return result;
}
