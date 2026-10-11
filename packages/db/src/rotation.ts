import { advanceCursor, localToday, planRotation } from '@tracker/core';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DbOrTransaction } from './client.js';
import { dueOrder } from './due.js';
import { household, member, occurrence, task, taskAssignee } from './schema/index.js';
import type { Occurrence } from './schema/index.js';

/*
 * Rotation in the database. `task.rotation_cursor` is the index (into the task's assignees, in
 * `position` order) of whose turn is next. The open occurrences that have not been started
 * (`upcoming` and `active`) are always the plan from that cursor (core's `planRotation`), so any
 * change to its inputs re-plans them; a plan from unchanged inputs updates nothing. The cursor
 * itself moves only when a turn is used up (`consumeRotationTurn`) or the assignee list changes
 * (the api remaps it with core's `remapCursor`). Started, done and skipped occurrences are never
 * touched. Planning needs the household's time zone to know which local day each due falls on.
 *
 * Limitation: an undated occurrence counts as due on the household's "today" when checking who is
 * away, but that is only evaluated when a plan runs. If the day changes without anything
 * triggering a re-plan (materialisation inserting rows, an assignee, mode or away change, a turn
 * being used up), an undated occurrence keeps the assignee chosen on the earlier day until then.
 *
 * Locking: every writer that changes a task's occurrences or its rotation takes the task row
 * first (`FOR NO KEY UPDATE`, which excludes other such writers but not the key-share locks that
 * inserts referencing the task take) and only then touches the occurrences: `replanRotation`
 * and `consumeRotationTurn` (so also the away change), `materialiseTask`, `activateDue`, the
 * api's task edits and `transitionOccurrence`, and deleting a task does so by itself. Code that
 * locks several tasks does so in `task.id` order. `clearFutureOpenOccurrences` expects its caller
 * to hold the lock.
 */

const NOT_STARTED = ['upcoming', 'active'] as const;

/** The task's assignee ids in rotation order. */
export async function assigneeIdsOf(db: DbOrTransaction, taskId: string): Promise<string[]> {
  const rows = await db
    .select({ memberId: taskAssignee.memberId })
    .from(taskAssignee)
    .where(eq(taskAssignee.taskId, taskId))
    .orderBy(asc(taskAssignee.position));
  return rows.map((row) => row.memberId);
}

/**
 * Re-plans who has the `upcoming` and `active` occurrences of a `rotation` task: dated ones in
 * due order, undated ones last (treated as due today for the away check), handed out from the
 * task's cursor and skipping members who are away on the due date. Does nothing for a task
 * that is not a rotation. Returns the number of occurrences whose assignee changed.
 */
export async function replanRotation(
  db: DbOrTransaction,
  taskId: string,
  options: { now: Date },
): Promise<{ updated: number }> {
  // Locked so that two changes to one rotation plan from the cursor they each see in turn.
  const [t] = await db
    .select({
      mode: task.assignmentMode,
      cursor: task.rotationCursor,
      timezone: household.timezone,
    })
    .from(task)
    .innerJoin(household, eq(household.id, task.householdId))
    .where(eq(task.id, taskId))
    .for('no key update', { of: task });
  if (t?.mode !== 'rotation') return { updated: 0 };
  const { timezone } = t;
  const today = localToday(options.now, timezone);

  const assigneeIds = await assigneeIdsOf(db, taskId);
  const away =
    assigneeIds.length === 0
      ? []
      : await db
          .select({ id: member.id, awayUntil: member.awayUntil })
          .from(member)
          .where(inArray(member.id, assigneeIds));
  const open = await db
    .select({
      id: occurrence.id,
      dueDate: occurrence.dueDate,
      dueAt: occurrence.dueAt,
      assigneeId: occurrence.assigneeId,
    })
    .from(occurrence)
    .where(and(eq(occurrence.taskId, taskId), inArray(occurrence.status, NOT_STARTED)))
    .orderBy(dueOrder(timezone), asc(occurrence.id));
  const slots = open.map((row) => ({
    ...row,
    date: row.dueDate ?? (row.dueAt ? localToday(row.dueAt, timezone) : today),
  }));

  const plan = planRotation({
    assigneeIds,
    cursor: t.cursor,
    slots,
    awayUntil: Object.fromEntries(away.map((m) => [m.id, m.awayUntil])),
  });

  // One UPDATE per assignee, for the occurrences that are not already theirs.
  const changes = new Map<string | null, string[]>();
  let updated = 0;
  slots.forEach((slot, i) => {
    const assigneeId = plan.assigneeIds[i] ?? null;
    if (slot.assigneeId === assigneeId) return;
    changes.set(assigneeId, [...(changes.get(assigneeId) ?? []), slot.id]);
    updated += 1;
  });
  for (const [assigneeId, ids] of changes) {
    await db
      .update(occurrence)
      .set({ assigneeId })
      .where(and(inArray(occurrence.id, ids), inArray(occurrence.status, NOT_STARTED)));
  }
  return { updated };
}

/**
 * Uses up the turn of the occurrence's assignee, for when the occurrence has just gone from
 * `previousStatus` to started, done or skipped: the cursor moves to the member after them, and
 * the task's remaining open occurrences are re-planned. Only an occurrence that was `upcoming`
 * or `active` has a turn to use up, so for any other `previousStatus` (such as completing one
 * that was already started) this does nothing, as it does for a task that is not a rotation.
 * Call it in the same transaction as the status change. Completion by someone else still uses
 * up the assignee's turn.
 */
export async function consumeRotationTurn(
  db: DbOrTransaction,
  occurrenceId: string,
  options: { now: Date; previousStatus: Occurrence['status'] },
): Promise<void> {
  if (!NOT_STARTED.some((status) => status === options.previousStatus)) return;
  // The task first, as every writer does. Which task is read before the lock (it never changes);
  // whose turn it is, only after it, since a re-plan may have reassigned the occurrence meanwhile.
  const [found] = await db
    .select({ taskId: occurrence.taskId })
    .from(occurrence)
    .where(eq(occurrence.id, occurrenceId));
  if (!found) return;
  const [t] = await db
    .select({ mode: task.assignmentMode, cursor: task.rotationCursor })
    .from(task)
    .where(eq(task.id, found.taskId))
    .for('no key update');
  if (t?.mode !== 'rotation') return;
  const [row] = await db
    .select({ assigneeId: occurrence.assigneeId })
    .from(occurrence)
    .where(eq(occurrence.id, occurrenceId));
  if (!row) return;

  const cursor = advanceCursor(await assigneeIdsOf(db, found.taskId), t.cursor, row.assigneeId);
  await db.update(task).set({ rotationCursor: cursor }).where(eq(task.id, found.taskId));
  await replanRotation(db, found.taskId, options);
}

/**
 * Re-plans every rotation task (not archived) the member is an assignee of, for when their
 * `away_until` changes. Returns the number of occurrences whose assignee changed.
 */
export async function replanRotationsForMember(
  db: DbOrTransaction,
  memberId: string,
  options: { now: Date },
): Promise<{ updated: number }> {
  const tasks = await db
    .select({ id: task.id })
    .from(taskAssignee)
    .innerJoin(task, eq(task.id, taskAssignee.taskId))
    .where(
      and(
        eq(taskAssignee.memberId, memberId),
        eq(task.assignmentMode, 'rotation'),
        isNull(task.archivedAt),
      ),
    )
    // A fixed order, so two members' changes cannot lock the same tasks in opposite orders.
    .orderBy(asc(task.id));
  let updated = 0;
  for (const { id } of tasks) updated += (await replanRotation(db, id, options)).updated;
  return { updated };
}
