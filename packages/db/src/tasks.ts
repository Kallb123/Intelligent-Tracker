import { OPEN_OCCURRENCE_STATUSES, type MilestoneInput } from '@tracker/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbOrTransaction } from './client.js';
import { materialiseTask } from './materialise.js';
import { one } from './rows.js';
import { keepUpdatedAt } from './schema/columns.js';
import {
  activity,
  occurrence,
  task,
  taskAssignee,
  taskMilestone,
  type NewTask,
  type Task,
} from './schema/index.js';

/** The `task` columns a caller chooses: everything but the household, creator and id. */
export type TaskValues = Omit<NewTask, 'householdId' | 'createdBy' | 'id'>;

/**
 * Replaces the task's assignee rows (in rotation order) and/or milestone rows with the given
 * lists; a list that is left out is not touched. The caller has checked the assignees belong to
 * the task's household. Call it in a transaction that holds the task row locked `for no key
 * update`; see `replaceMilestones` for how milestones are matched with the existing ones.
 */
export async function replaceTaskLists(
  db: DbOrTransaction,
  taskId: string,
  lists: { assignees?: string[]; milestones?: MilestoneInput[] },
): Promise<void> {
  const { assignees, milestones } = lists;
  if (assignees) {
    await db.delete(taskAssignee).where(eq(taskAssignee.taskId, taskId));
    if (assignees.length > 0) {
      await db
        .insert(taskAssignee)
        .values(assignees.map((memberId, position) => ({ taskId, memberId, position })));
    }
  }
  if (milestones) await replaceMilestones(db, taskId, milestones);
}

/**
 * Makes the task's milestone rows the given list, keeping the id of a milestone that is still
 * there: each incoming milestone takes the first not yet taken existing one with the same title,
 * and only its offset and position change. Ticks and reminders are keyed by milestone id, so
 * reordering, changing offsets and renaming or deleting *other* milestones keep them. Renaming a
 * milestone itself makes it a new one: nothing matches the new title, so the old row is deleted
 * and its tick dropped. Unmatched incoming milestones are inserted, and existing ones nothing
 * matched are deleted, with their ids removed from the `milestone_progress` of the task's open
 * occurrences.
 *
 * Call it in a transaction that holds the task row locked `for no key update` (as the api's task
 * edit does): the read-then-write of the rows and the prune would otherwise race other writers.
 */
async function replaceMilestones(
  db: DbOrTransaction,
  taskId: string,
  milestones: MilestoneInput[],
): Promise<void> {
  const existing = await db.select().from(taskMilestone).where(eq(taskMilestone.taskId, taskId));
  const unused = [...existing].sort((a, b) => a.position - b.position);
  const matched = milestones.map((m) => {
    const at = unused.findIndex((e) => e.title === m.title);
    return at < 0 ? undefined : unused.splice(at, 1)[0];
  });

  if (unused.length > 0) {
    const gone = unused.map((m) => m.id);
    await db.delete(taskMilestone).where(inArray(taskMilestone.id, gone));
    // Dead ids must not linger in ticks: they would show in the task's ticked list, the plan
    // hash and the planner's input.
    const open = await db
      .select({ id: occurrence.id, progress: occurrence.milestoneProgress })
      .from(occurrence)
      .where(
        and(
          eq(occurrence.taskId, taskId),
          inArray(occurrence.status, [...OPEN_OCCURRENCE_STATUSES]),
        ),
      );
    for (const { id, progress } of open) {
      if (!gone.some((g) => g in progress)) continue;
      const kept = Object.fromEntries(
        Object.entries(progress).filter(([key]) => !gone.includes(key)),
      );
      await db
        .update(occurrence)
        .set({ milestoneProgress: kept, updatedAt: keepUpdatedAt(occurrence) })
        .where(eq(occurrence.id, id));
    }
  }

  const kept = matched.flatMap((row, position) => (row ? [{ row, position }] : []));
  const changed = kept.filter(
    ({ row, position }) =>
      row.position !== position ||
      row.offsetDaysBeforeDue !== milestones[position]!.offsetDaysBeforeDue,
  );
  // Park the rows that move on negative positions first, so that reordering never meets the
  // unique (task_id, position) constraint half way. Rows that stay put are not touched.
  for (const [i, { row }] of changed.filter((c) => c.row.position !== c.position).entries()) {
    await db
      .update(taskMilestone)
      .set({ position: -(i + 1) })
      .where(eq(taskMilestone.id, row.id));
  }
  for (const { row, position } of changed) {
    await db
      .update(taskMilestone)
      .set({ offsetDaysBeforeDue: milestones[position]!.offsetDaysBeforeDue, position })
      .where(eq(taskMilestone.id, row.id));
  }
  const added = milestones.flatMap((m, position) =>
    matched[position]
      ? []
      : [{ taskId, title: m.title, offsetDaysBeforeDue: m.offsetDaysBeforeDue, position }],
  );
  if (added.length > 0) await db.insert(taskMilestone).values(added);
}

/**
 * Creates a task with its assignees and milestones, logs `task.created` and materialises its
 * first occurrences, all through `db`: run it in a transaction so a failure (such as a schedule
 * the recurrence engine rejects, which `materialiseTask` throws as `RecurrenceError`) leaves
 * nothing behind. The caller has validated the fields: the schedule, and that every assignee is
 * a member of the household.
 */
export async function createTask(
  db: DbOrTransaction,
  options: {
    householdId: string;
    /** The member creating it, also the actor of the activity entry. */
    createdBy: string;
    values: TaskValues;
    /** In rotation order. */
    assigneeIds: string[];
    milestones: MilestoneInput[];
    now: Date;
  },
): Promise<Task> {
  const { householdId, createdBy, values, assigneeIds, milestones, now } = options;
  const row = one(
    await db
      .insert(task)
      .values({ ...values, householdId, createdBy })
      .returning(),
  );
  await replaceTaskLists(db, row.id, { assignees: assigneeIds, milestones });
  await db.insert(activity).values({
    householdId,
    memberId: createdBy,
    taskId: row.id,
    kind: 'task.created',
    data: { title: row.title },
  });
  await materialiseTask(db, row.id, { now });
  return row;
}
