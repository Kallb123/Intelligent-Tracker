import type { TaskDto } from '@tracker/shared';
import { nextDueDate, nextMilestone } from './occurrences.js';

export const TASK_SORTS = ['due', 'milestone', 'title', 'priority', 'newest'] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

export const DEFAULT_TASK_SORT: TaskSort = 'due';

/** The choices for the "Sort by" select, in display order. */
export const TASK_SORT_OPTIONS: readonly { value: TaskSort; label: string }[] = [
  { value: 'due', label: 'Next due' },
  { value: 'milestone', label: 'Next milestone or due' },
  { value: 'title', label: 'Title (A–Z)' },
  { value: 'priority', label: 'Priority' },
  { value: 'newest', label: 'Newest first' },
];

export function isTaskSort(value: unknown): value is TaskSort {
  return typeof value === 'string' && (TASK_SORTS as readonly string[]).includes(value);
}

type Compare = (a: TaskDto, b: TaskDto) => number;

const byTitle: Compare = (a, b) => a.title.localeCompare(b.title);

/** Earliest next occurrence first (overdue ones are earliest); tasks with none go last. */
const byNextDue: Compare = (a, b) => {
  if (a.nextDue === b.nextDue) return 0;
  if (a.nextDue === null) return 1;
  if (b.nextDue === null) return -1;
  return Date.parse(a.nextDue) - Date.parse(b.nextDue);
};

/** What an order may depend on: the tasks being sorted and the moment and zone to judge them in. */
interface SortContext {
  tasks: readonly TaskDto[];
  now: Date;
  timeZone: string;
}

/**
 * Earliest local date of a task's next milestone or its due date first, whichever comes first;
 * tasks with no next occurrence go last. The keys are worked out once, not per comparison.
 */
function byMilestoneOrDue({ tasks, now, timeZone }: SortContext): Compare {
  const keys = new Map<TaskDto, string | null>();
  for (const task of tasks) {
    const due = nextDueDate(task, timeZone);
    const milestone = nextMilestone(task, now, timeZone);
    keys.set(
      task,
      milestone !== null && due !== null && milestone.date < due ? milestone.date : due,
    );
  }
  return (a, b) => {
    const keyA = keys.get(a) ?? null;
    const keyB = keys.get(b) ?? null;
    if (keyA === keyB) return 0;
    if (keyA === null) return 1;
    if (keyB === null) return -1;
    return keyA < keyB ? -1 : 1;
  };
}

/** Each order, then the tie-breakers that make it fully deterministic. */
const COMPARATORS: Record<TaskSort, (context: SortContext) => readonly Compare[]> = {
  due: () => [byNextDue, byTitle],
  milestone: (context) => [byMilestoneOrDue(context), byNextDue, byTitle],
  title: () => [byTitle, (a, b) => a.id.localeCompare(b.id)],
  priority: () => [(a, b) => b.priority - a.priority, byNextDue, byTitle],
  newest: () => [(a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt), byTitle],
};

/** The tasks in the given order, as a new array. `now` and `timeZone` matter for milestone dates. */
export function sortTasks(
  tasks: readonly TaskDto[],
  sort: TaskSort,
  now: Date,
  timeZone: string,
): TaskDto[] {
  const steps = COMPARATORS[sort]({ tasks, now, timeZone });
  return [...tasks].sort((a, b) => {
    for (const step of steps) {
      const result = step(a, b);
      if (result !== 0) return result;
    }
    return 0;
  });
}
