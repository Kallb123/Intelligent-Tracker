import { advanceCursor, localToday, planRotation, startOfLocalDay } from '@tracker/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbOrTransaction } from './client.js';
import { household, member, occurrence, task, taskAssignee } from './schema/index.js';

/*
 * Rotation in the database. `task.rotation_cursor` is the index (into the task's assignees, in
 * `position` order) of whose turn is next. The open occurrences that have not been started
 * (`upcoming` and `active`) are always the plan from that cursor (core's `planRotation`), so any
 * change to its inputs re-plans them; a plan from unchanged inputs updates nothing. The cursor
 * itself moves only when a turn is used up (`consumeRotationTurn`) or the assignee list changes
 * (the api remaps it with core's `remapCursor`). Started, done and skipped occurrences are never
 * touched. Planning needs the household's time zone to know which local day each due falls on.
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
    .for('update', { of: task });
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
    .where(and(eq(occurrence.taskId, taskId), inArray(occurrence.status, NOT_STARTED)));

  // Due order: by instant (an all-day due starts at local midnight), undated last, then by id.
  const slots = open
    .map((row) => {
      const at = row.dueAt ?? (row.dueDate ? startOfLocalDay(row.dueDate, timezone) : null);
      return {
        ...row,
        sortKey: at?.getTime() ?? Infinity,
        date: row.dueDate ?? (row.dueAt ? localToday(row.dueAt, timezone) : today),
      };
    })
    .sort((a, b) => a.sortKey - b.sortKey || a.id.localeCompare(b.id));

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
    await db.update(occurrence).set({ assigneeId }).where(inArray(occurrence.id, ids));
  }
  return { updated };
}

/**
 * Uses up the turn of the occurrence's assignee, for when it goes from `upcoming` or `active`
 * to started, done or skipped: the cursor moves to the member after them, and the task's
 * remaining open occurrences are re-planned. Call it in the same transaction as the status
 * change, and only when the occurrence was not already started. Does nothing for an occurrence
 * of a task that is not a rotation. Completion by someone else still uses up the assignee's turn.
 */
export async function consumeRotationTurn(
  db: DbOrTransaction,
  occurrenceId: string,
  options: { now: Date },
): Promise<void> {
  const [row] = await db
    .select({ taskId: occurrence.taskId, assigneeId: occurrence.assigneeId })
    .from(occurrence)
    .where(eq(occurrence.id, occurrenceId));
  if (!row) return;
  const [t] = await db
    .select({ mode: task.assignmentMode, cursor: task.rotationCursor })
    .from(task)
    .where(eq(task.id, row.taskId))
    .for('update');
  if (t?.mode !== 'rotation') return;

  const cursor = advanceCursor(await assigneeIdsOf(db, row.taskId), t.cursor, row.assigneeId);
  await db.update(task).set({ rotationCursor: cursor }).where(eq(task.id, row.taskId));
  await replanRotation(db, row.taskId, options);
}

/**
 * Re-plans every rotation task the member is an assignee of, for when their
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
    .where(and(eq(taskAssignee.memberId, memberId), eq(task.assignmentMode, 'rotation')))
    // A fixed order, so two members' changes cannot lock the same tasks in opposite orders.
    .orderBy(asc(task.id));
  let updated = 0;
  for (const { id } of tasks) updated += (await replanRotation(db, id, options)).updated;
  return { updated };
}
