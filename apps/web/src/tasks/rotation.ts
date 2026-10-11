import { isAwayOn } from '@tracker/core';
import type { MemberDto, TaskDto } from '@tracker/shared';
import { formatDayHeading } from '../format.js';

/** Away dates and rotation order: pure helpers for the People page, task editor and task list. */

/** Whether the member is away today. `awayUntil` is inclusive; a date in the past means back. */
export function isAway(member: Pick<MemberDto, 'awayUntil'>, today: string): boolean {
  return isAwayOn(member.awayUntil, today);
}

/** "until Tue 14 Oct" while the member is away, otherwise ''. */
function untilText(member: Pick<MemberDto, 'awayUntil'>, today: string): string {
  return member.awayUntil !== null && isAway(member, today)
    ? `until ${formatDayHeading(member.awayUntil, today)}`
    : '';
}

/** "Away until Tue 14 Oct", or '' when the member is not away. */
export function describeAway(member: Pick<MemberDto, 'awayUntil'>, today: string): string {
  const until = untilText(member, today);
  return until && `Away ${until}`;
}

/** A member's name for a picker, flagged when away: "Sam (away until Wed 14 Oct)". */
export function memberLabel(member: Pick<MemberDto, 'name' | 'awayUntil'>, today: string): string {
  const until = untilText(member, today);
  return until ? `${member.name} (away ${until})` : member.name;
}

/** A copy of `list` with the item at `index` moved by `offset` places; out of range changes nothing. */
export function moveItem<T>(list: readonly T[], index: number, offset: number): T[] {
  const target = index + offset;
  const copy = [...list];
  if (index < 0 || index >= copy.length || target < 0 || target >= copy.length) return copy;
  const [item] = copy.splice(index, 1);
  copy.splice(target, 0, item as T);
  return copy;
}

/** Live tasks where the member takes turns. */
export function rotationsOf(tasks: readonly TaskDto[], memberId: string): TaskDto[] {
  return tasks.filter(
    (t) => !t.archived && t.assignmentMode === 'rotation' && t.assigneeIds.includes(memberId),
  );
}

/** Who a task is for: "Alex", "Alex, Sam" (in turn order) or "anyone". */
export function describeAssignees(task: TaskDto, nameOf: (id: string) => string): string {
  return task.assigneeIds.length === 0 ? 'anyone' : task.assigneeIds.map(nameOf).join(', ');
}

/** The name of whose turn it is on a rotation task, or '' for other tasks and when none is open. */
export function nextUpName(task: TaskDto, nameOf: (id: string) => string): string {
  return task.assignmentMode === 'rotation' && task.nextAssigneeId
    ? nameOf(task.nextAssigneeId)
    : '';
}
