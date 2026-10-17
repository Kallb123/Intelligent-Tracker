import type { MilestoneInput } from '@tracker/shared';
import { eq } from 'drizzle-orm';
import type { DbOrTransaction } from './client.js';
import { materialiseTask } from './materialise.js';
import { one } from './rows.js';
import {
  activity,
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
 * the task's household.
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
  if (milestones) {
    await db.delete(taskMilestone).where(eq(taskMilestone.taskId, taskId));
    if (milestones.length > 0) {
      await db.insert(taskMilestone).values(
        milestones.map((m, position) => ({
          taskId,
          title: m.title,
          offsetDaysBeforeDue: m.offsetDaysBeforeDue,
          position,
        })),
      );
    }
  }
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
