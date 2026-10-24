import type { TaskDto } from '@tracker/shared';

export const TASK_SORTS = ['due', 'title', 'priority', 'newest'] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

export const DEFAULT_TASK_SORT: TaskSort = 'due';

/** The choices for the "Sort by" select, in display order. */
export const TASK_SORT_OPTIONS: readonly { value: TaskSort; label: string }[] = [
  { value: 'due', label: 'Next due' },
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

/** Each order, then the tie-breakers that make it fully deterministic. */
const COMPARATORS: Record<TaskSort, readonly Compare[]> = {
  due: [byNextDue, byTitle],
  title: [byTitle, (a, b) => a.id.localeCompare(b.id)],
  priority: [(a, b) => b.priority - a.priority, byNextDue, byTitle],
  newest: [(a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt), byTitle],
};

/** The tasks in the given order, as a new array. */
export function sortTasks(tasks: readonly TaskDto[], sort: TaskSort): TaskDto[] {
  const steps = COMPARATORS[sort];
  return [...tasks].sort((a, b) => {
    for (const step of steps) {
      const result = step(a, b);
      if (result !== 0) return result;
    }
    return 0;
  });
}
