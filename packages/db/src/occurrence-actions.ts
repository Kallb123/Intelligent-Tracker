import { OPEN_OCCURRENCE_STATUSES, type OccurrenceStatus } from '@tracker/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database, DbOrTransaction } from './client.js';
import { materialiseTask } from './materialise.js';
import { consumeRotationTurn } from './rotation.js';
import { activity, occurrence, task, taskMilestone, type NewOccurrence } from './schema/index.js';

/*
 * What members do with an occurrence: complete, skip, snooze or start it, or tick one of its
 * milestones. Shared by the api and the Telegram bot, which both act on behalf of a member of a
 * household.
 */

/** An action on one occurrence, by a member of its household. */
export type OccurrenceAction =
  /** Done: closes the occurrence; for an `after_completion` task the next one is created. */
  | { type: 'complete' }
  /** Like complete, but counts as skipped. */
  | { type: 'skip' }
  /** Hides an open occurrence from the today and overdue views until `until`. */
  | { type: 'snooze'; until: Date }
  /** Marks an upcoming or active occurrence as started; already started is a no-op. */
  | { type: 'start' }
  /**
   * Ticks (`done`) or unticks one of the task's milestones on this occurrence. A ticked
   * milestone stops its reminder (see `planReminders`). Only open occurrences can be changed;
   * ticking what is already ticked, or unticking what is not, changes nothing.
   */
  | { type: 'milestone'; milestoneId: string; done: boolean };

export interface OccurrenceActionInput {
  /** Occurrences of any other household do not exist as far as the action is concerned. */
  householdId: string;
  /** The member the action is attributed to (`completedBy`, the activity log). */
  memberId: string;
  occurrenceId: string;
  now: Date;
  action: OccurrenceAction;
}

export interface OccurrenceActionResult {
  taskId: string;
  /** The occurrence's status after the action. */
  status: OccurrenceStatus;
  /**
   * False when nothing was done because the occurrence was already started (`start`) or the
   * milestone was already as asked (`milestone`).
   */
  changed: boolean;
  /** Ids of occurrences the action created (the next one of an `after_completion` task). */
  createdIds: string[];
}

/**
 * Why an action was refused: `not_found` (no such occurrence in the household),
 * `milestone_not_found` (the task has no such milestone) or `occurrence_closed` (it is done or
 * skipped, or for `start` also not open any more), with its current `status`.
 */
export class OccurrenceActionError extends Error {
  constructor(
    readonly code: 'not_found' | 'milestone_not_found' | 'occurrence_closed',
    readonly status?: OccurrenceStatus,
  ) {
    super(
      code === 'not_found'
        ? 'No such occurrence'
        : code === 'milestone_not_found'
          ? 'No such milestone'
          : `That occurrence is already ${status}`,
    );
    this.name = 'OccurrenceActionError';
  }
}

/** The activity kind that logs a milestone being ticked off (`data.milestoneId` says which). */
export const MILESTONE_DONE_ACTIVITY = 'occurrence.milestone_done';

const NOT_STARTED = ['upcoming', 'active'] as const satisfies OccurrenceStatus[];

/** The occurrence as read under its lock, before a change. */
interface Before {
  status: OccurrenceStatus;
  milestoneProgress: Record<string, unknown>;
}

/** What a status change does to an occurrence and how it is logged. */
interface Transition {
  /** Statuses the occurrence may currently have; any other is `occurrence_closed`. */
  from: readonly OccurrenceStatus[];
  changes: Partial<
    Pick<
      NewOccurrence,
      'status' | 'snoozedUntil' | 'completedAt' | 'completedBy' | 'milestoneProgress'
    >
  >;
  /** Throws `OccurrenceActionError` if the action does not make sense for this task. */
  validate?: (tx: DbOrTransaction, taskId: string) => Promise<void>;
  /** True when the occurrence is already as the action wants it: success, nothing logged. */
  unchanged?: (before: Before) => boolean;
  activityKind: string;
  activityData?: Record<string, unknown>;
  /** Treated as success without doing anything when the occurrence is already in this status. */
  idempotentIn?: OccurrenceStatus;
  /** Runs in the same transaction after the change; returns ids of occurrences it created. */
  after?: (
    tx: DbOrTransaction,
    taskId: string,
    previousStatus: OccurrenceStatus,
  ) => Promise<string[]>;
}

function transitionFor(
  { memberId, occurrenceId, now, action }: OccurrenceActionInput,
  before: Before,
): Transition {
  switch (action.type) {
    case 'complete':
    case 'skip': {
      const status = action.type === 'complete' ? 'done' : 'skipped';
      return {
        from: OPEN_OCCURRENCE_STATUSES,
        changes: { status, completedAt: now, completedBy: memberId, snoozedUntil: null },
        activityKind: `occurrence.${status === 'done' ? 'completed' : 'skipped'}`,
        // Uses up the assignee's rotation turn and lets the schedule produce the next occurrence.
        after: async (tx, taskId, previousStatus) => {
          await consumeRotationTurn(tx, occurrenceId, { now, previousStatus });
          return (await materialiseTask(tx, taskId, { now })).occurrenceIds;
        },
      };
    }
    case 'snooze':
      return {
        from: OPEN_OCCURRENCE_STATUSES,
        changes: { snoozedUntil: action.until },
        activityKind: 'occurrence.snoozed',
        activityData: { until: action.until.toISOString() },
      };
    case 'start':
      return {
        from: NOT_STARTED,
        changes: { status: 'started', snoozedUntil: null },
        activityKind: 'occurrence.started',
        idempotentIn: 'started',
        // Uses up the assignee's rotation turn (a no-op if it had already been started).
        after: async (tx, _taskId, previousStatus) => {
          await consumeRotationTurn(tx, occurrenceId, { now, previousStatus });
          return [];
        },
      };
    case 'milestone': {
      const { milestoneId, done } = action;
      // The key is removed on untick, so the column only holds what is ticked: the completion
      // time (see `completedMilestoneIds`).
      const rest = { ...before.milestoneProgress };
      delete rest[milestoneId];
      return {
        from: OPEN_OCCURRENCE_STATUSES,
        changes: { milestoneProgress: done ? { ...rest, [milestoneId]: now.toISOString() } : rest },
        validate: async (tx, taskId) => {
          const [row] = await tx
            .select({ id: taskMilestone.id })
            .from(taskMilestone)
            .where(and(eq(taskMilestone.id, milestoneId), eq(taskMilestone.taskId, taskId)));
          if (!row) throw new OccurrenceActionError('milestone_not_found');
        },
        unchanged: (b) => Boolean(b.milestoneProgress[milestoneId]) === done,
        activityKind: done ? MILESTONE_DONE_ACTIVITY : 'occurrence.milestone_undone',
        activityData: { milestoneId },
      };
    }
  }
}

/**
 * Applies `action` to the household's occurrence in its own transaction and logs it as the
 * member's activity. The change is a single conditional UPDATE, so of two simultaneous requests
 * only one finds the occurrence still open; the other gets `occurrence_closed` (or, for `start`,
 * the already-started occurrence with `changed: false`).
 *
 * Starting, completing or skipping an occurrence that was not yet started uses up its assignee's
 * turn in the task's rotation (see `consumeRotationTurn`). The caller validates `snooze`'s
 * `until` (it should be in the future). Throws `OccurrenceActionError`.
 */
export async function applyOccurrenceAction(
  db: Database,
  input: OccurrenceActionInput,
): Promise<OccurrenceActionResult> {
  const { householdId, memberId, occurrenceId } = input;

  return db.transaction(async (tx) => {
    const owned = tx.select({ id: task.id }).from(task).where(eq(task.householdId, householdId));
    // Lock order is task, then occurrence, like every other writer, so the actions cannot
    // deadlock with task edits, away changes or the worker. The lock on the occurrence also
    // makes the status read below and the change after it one step, so exactly one request
    // sees the occurrence not yet started and uses up the turn.
    const [ref] = await tx
      .select({ taskId: occurrence.taskId })
      .from(occurrence)
      .where(and(eq(occurrence.id, occurrenceId), inArray(occurrence.taskId, owned)));
    if (!ref) throw new OccurrenceActionError('not_found');
    await tx.select({ id: task.id }).from(task).where(eq(task.id, ref.taskId)).for('no key update');
    const [before] = await tx
      .select({ status: occurrence.status, milestoneProgress: occurrence.milestoneProgress })
      .from(occurrence)
      .where(eq(occurrence.id, occurrenceId))
      .for('no key update');
    // Gone while waiting for the lock (the task was deleted or rescheduled).
    if (!before) throw new OccurrenceActionError('not_found');
    const transition = transitionFor(input, before);
    if (transition.from.includes(before.status)) {
      await transition.validate?.(tx, ref.taskId);
      if (transition.unchanged?.(before)) {
        return { taskId: ref.taskId, status: before.status, changed: false, createdIds: [] };
      }
    }
    const changed = await tx
      .update(occurrence)
      .set(transition.changes)
      .where(
        and(
          eq(occurrence.id, occurrenceId),
          inArray(occurrence.status, [...transition.from]),
          inArray(occurrence.taskId, owned),
        ),
      )
      .returning({ taskId: occurrence.taskId });

    const [current] = await tx
      .select({ status: occurrence.status, title: task.title })
      .from(occurrence)
      .innerJoin(task, eq(task.id, occurrence.taskId))
      .where(and(eq(occurrence.id, occurrenceId), eq(task.householdId, householdId)))
      .limit(1);
    if (!current) throw new OccurrenceActionError('not_found');
    const changedRow = changed[0];
    if (changedRow === undefined) {
      if (current.status === transition.idempotentIn) {
        return { taskId: ref.taskId, status: current.status, changed: false, createdIds: [] };
      }
      throw new OccurrenceActionError('occurrence_closed', current.status);
    }

    await tx.insert(activity).values({
      householdId,
      memberId,
      taskId: changedRow.taskId,
      occurrenceId,
      kind: transition.activityKind,
      data: { title: current.title, ...transition.activityData },
    });
    const createdIds = (await transition.after?.(tx, changedRow.taskId, before.status)) ?? [];
    return { taskId: changedRow.taskId, status: current.status, changed: true, createdIds };
  });
}
