import { addLocalDays, localToday, milestoneDay } from '@tracker/core';
import {
  formatDayHeading,
  type MemberDto,
  type OccurrenceDto,
  type TaskDto,
} from '@tracker/shared';
import { formatTime } from '../format.js';

/** The household-local calendar date an occurrence is due, or null for an undated one. */
export function dueDateOf(occurrence: OccurrenceDto, timeZone: string): string | null {
  if (occurrence.dueDate) return occurrence.dueDate;
  return occurrence.dueAt ? localToday(new Date(occurrence.dueAt), timeZone) : null;
}

/** `at 14:30` for a timed occurrence, empty for an all-day or undated one. */
function atTime(occurrence: OccurrenceDto, timeZone: string): string {
  return occurrence.dueAt && !occurrence.task.allDay
    ? ` at ${formatTime(occurrence.dueAt, timeZone)}`
    : '';
}

/** `today`, `tomorrow`, or a short date like `Fri 16 Oct`, relative to `today`. */
function relativeDay(date: string, today: string): string {
  if (date === today) return 'today';
  return date === addLocalDays(today, 1) ? 'tomorrow' : formatDayHeading(date, today);
}

/**
 * When an occurrence is due, in words relative to `today` (a `YYYY-MM-DD` in the household's
 * zone): "Due today", "Due tomorrow at 09:00", "Overdue, was due Mon 5 Oct", "No date".
 */
export function describeDue(occurrence: OccurrenceDto, today: string, timeZone: string): string {
  const date = dueDateOf(occurrence, timeZone);
  if (date === null) return 'No date';
  const at = atTime(occurrence, timeZone);
  const when = relativeDay(date, today);
  return occurrence.overdue ? `Overdue, was due ${when}${at}` : `Due ${when}${at}`;
}

/**
 * When a task's earliest open occurrence is due, relative to `now` in the household's zone
 * ("Next due tomorrow", "Next due today at 09:30, overdue"), or an empty string when it has none.
 * A timed due is overdue once its instant has passed, an all-day one from the day after.
 */
export function describeNextDue(
  task: Pick<TaskDto, 'nextDue' | 'allDay'>,
  now: Date,
  timeZone: string,
): string {
  if (task.nextDue === null) return '';
  const due = new Date(task.nextDue);
  const today = localToday(now, timeZone);
  const date = localToday(due, timeZone);
  const at = task.allDay ? '' : ` at ${formatTime(due, timeZone)}`;
  const overdue = task.allDay ? date < today : due < now;
  return `Next due ${relativeDay(date, today)}${at}${overdue ? ', overdue' : ''}`;
}

/** The household-local `YYYY-MM-DD` a task's next occurrence is due, or null when it has none. */
export function nextDueDate(task: Pick<TaskDto, 'nextDue'>, timeZone: string): string | null {
  return task.nextDue === null ? null : localToday(new Date(task.nextDue), timeZone);
}

export interface NextMilestone {
  title: string;
  /** Household-local `YYYY-MM-DD`. */
  date: string;
}

/**
 * The next milestone of a task's next open occurrence: the earliest unticked one dated today or
 * later, the first listed on a tie. Each date is its offset before the due date. Null when the
 * task has no next occurrence, or no milestone left that is unticked and not yet passed.
 */
export function nextMilestone(
  task: Pick<TaskDto, 'nextDue' | 'milestones' | 'nextCompletedMilestoneIds'>,
  now: Date,
  timeZone: string,
): NextMilestone | null {
  const dueDate = nextDueDate(task, timeZone);
  if (dueDate === null) return null;
  const today = localToday(now, timeZone);
  const ticked = new Set(task.nextCompletedMilestoneIds);
  let next: NextMilestone | null = null;
  for (const milestone of task.milestones) {
    if (ticked.has(milestone.id)) continue;
    const date = milestoneDay(dueDate, milestone.offsetDaysBeforeDue);
    if (date >= today && (next === null || date < next.date)) {
      next = { title: milestone.title, date };
    }
  }
  return next;
}

/**
 * The next milestone in words relative to `now` in the household's zone ("Next milestone: Book
 * venue, tomorrow"), or an empty string when there is none.
 */
export function describeNextMilestone(
  task: Pick<TaskDto, 'nextDue' | 'milestones' | 'nextCompletedMilestoneIds'>,
  now: Date,
  timeZone: string,
): string {
  const milestone = nextMilestone(task, now, timeZone);
  if (milestone === null) return '';
  return `Next milestone: ${milestone.title}, ${relativeDay(milestone.date, localToday(now, timeZone))}`;
}

/**
 * The date the prep window opens ("Prep starts Wed 14 Oct"), only when it opens before the due
 * date; a lead time of zero days has nothing to announce.
 */
export function describePrepStart(
  occurrence: OccurrenceDto,
  today: string,
  timeZone: string,
): string {
  if (!occurrence.startAt) return '';
  const start = localToday(new Date(occurrence.startAt), timeZone);
  const due = dueDateOf(occurrence, timeZone);
  if (due === null || start >= due) return '';
  return `${start <= today ? 'Prep started' : 'Prep starts'} ${formatDayHeading(start, today)}`;
}

export interface OccurrenceGroup {
  /** Stable key for `v-for`: a member id, or `anyone`. */
  key: string;
  /** Who it is for, such as "Alex (you)" or "Anyone". */
  name: string;
  occurrences: OccurrenceDto[];
}

/**
 * Splits occurrences by assignee, keeping their order within a group. The logged-in member comes
 * first, then the others in household order, then unassigned items as "Anyone". A group only
 * exists if it has something in it.
 */
export function groupByAssignee(
  occurrences: readonly OccurrenceDto[],
  members: readonly MemberDto[],
  currentMemberId: string | undefined,
): OccurrenceGroup[] {
  const known = [...members].sort(
    (a, b) => Number(b.id === currentMemberId) - Number(a.id === currentMemberId),
  );
  const groups: OccurrenceGroup[] = known.map((m) => ({
    key: m.id,
    name: m.id === currentMemberId ? `${m.name} (you)` : m.name,
    occurrences: occurrences.filter((o) => o.assigneeId === m.id),
  }));
  const knownIds = new Set(members.map((m) => m.id));
  groups.push({
    key: 'anyone',
    name: 'Anyone',
    occurrences: occurrences.filter((o) => o.assigneeId === null || !knownIds.has(o.assigneeId)),
  });
  return groups.filter((g) => g.occurrences.length > 0);
}

export interface DateGroup {
  /** `YYYY-MM-DD`, or null for undated occurrences. */
  date: string | null;
  occurrences: OccurrenceDto[];
}

/** Splits occurrences by the day they are due, in the order they first appear. */
export function groupByDate(occurrences: readonly OccurrenceDto[], timeZone: string): DateGroup[] {
  const groups = new Map<string | null, OccurrenceDto[]>();
  for (const o of occurrences) {
    const date = dueDateOf(o, timeZone);
    const group = groups.get(date);
    if (group) group.push(o);
    else groups.set(date, [o]);
  }
  return [...groups].map(([date, list]) => ({ date, occurrences: list }));
}
