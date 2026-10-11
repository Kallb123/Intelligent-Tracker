import type { LocalDate } from '../recurrence/types.js';

/*
 * Rotation: a task with `assignmentMode: 'rotation'` hands its occurrences to its assignees in
 * turn. `cursor` is an index into the ordered assignee list and says whose turn is next. This
 * module is pure: the database layer loads the inputs and stores the results.
 */

/** One open occurrence waiting for an assignee. */
export interface RotationSlot {
  /** The household-local date the occurrence is due (for an undated one, today). */
  date: LocalDate;
}

export interface RotationPlanInput {
  /** The task's assignees in rotation order. */
  assigneeIds: readonly string[];
  /** Index of whose turn is next; any integer, it is wrapped into the list. */
  cursor: number;
  /** The open, not started occurrences in due order. */
  slots: readonly RotationSlot[];
  /** Each member's `away_until`; a member missing from the record is not away. */
  awayUntil: Readonly<Record<string, string | null | undefined>>;
}

export interface RotationPlan {
  /** The assignee of each slot, in slot order; all `null` when there is nobody to assign. */
  assigneeIds: (string | null)[];
  /** Whose turn it is after the last slot, as an index into `assigneeIds` of the input. */
  cursor: number;
}

/** `index` wrapped into `0..length-1`; 0 for an empty list. */
function wrap(index: number, length: number): number {
  return length === 0 ? 0 : ((index % length) + length) % length;
}

/** True when a member whose `away_until` is `awayUntil` is away on `date` (the last day counts). */
export function isAwayOn(awayUntil: string | null | undefined, date: LocalDate): boolean {
  return awayUntil !== null && awayUntil !== undefined && date <= awayUntil;
}

/**
 * Assigns the slots round-robin from `cursor`. For each slot the member whose turn it is takes
 * it unless they are away on its date, in which case the next member who is not away does; if
 * everyone is away, the member whose turn it is takes it anyway. Whoever takes a slot passes the
 * turn to the member after them in the list. The cursor is not stored anywhere by this: it only
 * moves for real when a turn is consumed (`advanceCursor`) or the list changes (`remapCursor`).
 */
export function planRotation(input: RotationPlanInput): RotationPlan {
  const { assigneeIds, slots, awayUntil } = input;
  const n = assigneeIds.length;
  if (n === 0) return { assigneeIds: slots.map(() => null), cursor: 0 };

  let turn = wrap(input.cursor, n);
  const assigned = slots.map((slot) => {
    const order = Array.from({ length: n }, (_, offset) => wrap(turn + offset, n));
    const index =
      order.find((i) => !isAwayOn(awayUntil[assigneeIds[i] as string], slot.date)) ?? turn;
    turn = wrap(index + 1, n);
    return assigneeIds[index] as string;
  });
  return { assigneeIds: assigned, cursor: turn };
}

/**
 * The cursor after the turn of `consumedAssigneeId` is used up (their occurrence was started,
 * completed or skipped): the member after them. When that assignee is `null` or no longer in the
 * list the cursor just moves on by one.
 */
export function advanceCursor(
  assigneeIds: readonly string[],
  cursor: number,
  consumedAssigneeId: string | null,
): number {
  const index = consumedAssigneeId === null ? -1 : assigneeIds.indexOf(consumedAssigneeId);
  return wrap(index === -1 ? cursor + 1 : index + 1, assigneeIds.length);
}

/**
 * The cursor for a replaced assignee list: it keeps pointing at the member whose turn it was,
 * wherever they are in `newIds`, and falls back to the start when they are gone (or there was
 * nobody to have a turn).
 */
export function remapCursor(
  oldIds: readonly string[],
  cursor: number,
  newIds: readonly string[],
): number {
  const next = oldIds[wrap(cursor, oldIds.length)];
  const index = next === undefined ? -1 : newIds.indexOf(next);
  return Math.max(index, 0);
}
