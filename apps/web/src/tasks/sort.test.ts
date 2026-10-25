import type { TaskDto } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_SORT,
  isTaskSort,
  sortTasks,
  TASK_SORT_OPTIONS,
  TASK_SORTS,
  type TaskSort,
} from './sort.js';

const NOW = new Date('2026-10-11T10:00:00.000Z'); // 11:00 on 2026-10-11 in London (BST)
const TZ = 'Europe/London';
const order = (tasks: TaskDto[], sort: TaskSort) => sortTasks(tasks, sort, NOW, TZ);

let counter = 0;
const task = (overrides: Partial<TaskDto>): TaskDto => {
  counter += 1;
  return {
    id: `id-${String(counter).padStart(3, '0')}`,
    title: 'Task',
    priority: 0,
    nextDue: null,
    milestones: [],
    nextCompletedMilestoneIds: [],
    createdAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  } as TaskDto;
};
const titles = (tasks: TaskDto[]) => tasks.map((t) => t.title);

describe('isTaskSort', () => {
  it('accepts every known sort and nothing else', () => {
    for (const sort of TASK_SORTS) expect(isTaskSort(sort)).toBe(true);
    for (const bad of ['', 'Due', 'random', null, undefined, 1, {}]) {
      expect(isTaskSort(bad)).toBe(false);
    }
  });

  it('defaults to a known sort, and every sort has a labelled option', () => {
    expect(isTaskSort(DEFAULT_TASK_SORT)).toBe(true);
    expect(DEFAULT_TASK_SORT).toBe('due');
    expect(TASK_SORT_OPTIONS.map((o) => o.value)).toEqual([...TASK_SORTS]);
    expect(TASK_SORT_OPTIONS.map((o) => o.label)).toEqual([
      'Next due',
      'Next milestone or due',
      'Title (A–Z)',
      'Priority',
      'Newest first',
    ]);
  });
});

describe('sortTasks by next due', () => {
  it('puts the earliest first, overdue naturally ahead, and undated tasks last', () => {
    const tasks = [
      task({ title: 'Undated' }),
      task({ title: 'Later', nextDue: '2026-11-01T00:00:00.000Z' }),
      task({ title: 'Overdue', nextDue: '2026-10-01T00:00:00.000Z' }),
      task({ title: 'Soon', nextDue: '2026-10-12T08:00:00.000Z' }),
    ];
    expect(titles(order(tasks, 'due'))).toEqual(['Overdue', 'Soon', 'Later', 'Undated']);
  });

  it('compares instants, not strings', () => {
    const tasks = [
      task({ title: 'B', nextDue: '2026-10-12T10:00:00.000Z' }),
      task({ title: 'A', nextDue: '2026-10-12T09:30:00.000Z' }),
    ];
    expect(titles(order(tasks, 'due'))).toEqual(['A', 'B']);
  });

  it('breaks ties by title, including among undated tasks', () => {
    const tasks = [
      task({ title: 'Zeta', nextDue: '2026-10-12T00:00:00.000Z' }),
      task({ title: 'Mu' }),
      task({ title: 'Alpha', nextDue: '2026-10-12T00:00:00.000Z' }),
      task({ title: 'Beta' }),
    ];
    expect(titles(order(tasks, 'due'))).toEqual(['Alpha', 'Zeta', 'Beta', 'Mu']);
  });
});

describe('sortTasks by next milestone or due', () => {
  // All-day dues are local midnight in London (BST), so 2026-10-14 is 2026-10-13T23:00Z.
  const day14 = '2026-10-13T23:00:00.000Z';
  const day20 = '2026-10-19T23:00:00.000Z';
  const milestone = (offsetDaysBeforeDue: number) => ({
    id: `m-${String(offsetDaysBeforeDue)}`,
    title: 'Milestone',
    offsetDaysBeforeDue,
  });

  it('puts a task due later but with an upcoming milestone ahead of one due sooner', () => {
    const tasks = [
      task({ title: 'Due sooner', nextDue: day14 }),
      task({ title: 'Due later', nextDue: day20, milestones: [milestone(7)] }),
    ];
    expect(titles(order(tasks, 'milestone'))).toEqual(['Due later', 'Due sooner']);
    expect(titles(order(tasks, 'due'))).toEqual(['Due sooner', 'Due later']);
  });

  it('ignores milestones that have passed', () => {
    const tasks = [
      task({ title: 'Passed', nextDue: day20, milestones: [milestone(15)] }),
      task({ title: 'Due sooner', nextDue: day14 }),
    ];
    expect(titles(order(tasks, 'milestone'))).toEqual(['Due sooner', 'Passed']);
  });

  it('sorts by the next unticked milestone, not a ticked one', () => {
    const tasks = [
      task({ title: 'Due sooner', nextDue: day14 }),
      task({
        title: 'Ticked',
        nextDue: day20,
        milestones: [milestone(7)],
        nextCompletedMilestoneIds: ['m-7'],
      }),
      task({
        title: 'Second milestone',
        nextDue: day20,
        milestones: [milestone(7), milestone(8)],
        nextCompletedMilestoneIds: ['m-7'],
      }),
    ];
    // 'Second milestone' falls back to its 12 Oct milestone; 'Ticked' has none left and sorts by
    // its due date.
    expect(titles(order(tasks, 'milestone'))).toEqual(['Second milestone', 'Due sooner', 'Ticked']);
  });

  it('counts a milestone dated today', () => {
    const tasks = [
      task({ title: 'Due sooner', nextDue: day14 }),
      task({ title: 'Today', nextDue: day20, milestones: [milestone(9)] }),
    ];
    expect(titles(order(tasks, 'milestone'))).toEqual(['Today', 'Due sooner']);
  });

  it('keeps overdue tasks first and undated tasks last', () => {
    const tasks = [
      task({ title: 'Undated', milestones: [milestone(1)] }),
      task({ title: 'Milestone', nextDue: day20, milestones: [milestone(8)] }),
      task({ title: 'Overdue', nextDue: '2026-10-01T00:00:00.000Z', milestones: [milestone(3)] }),
    ];
    expect(titles(order(tasks, 'milestone'))).toEqual(['Overdue', 'Milestone', 'Undated']);
  });

  it('breaks ties by next due, then title', () => {
    const tasks = [
      task({ title: 'Later due', nextDue: day20, milestones: [milestone(6)] }),
      task({ title: 'Zeta', nextDue: day14 }),
      task({ title: 'Alpha', nextDue: day14 }),
    ];
    expect(titles(order(tasks, 'milestone'))).toEqual(['Alpha', 'Zeta', 'Later due']);
  });

  it('judges milestone dates in the given time zone', () => {
    // 00:30 on the 20th in London, but still the 19th in UTC.
    const tasks = [
      task({ title: 'Plain', nextDue: '2026-10-19T08:00:00.000Z' }),
      task({ title: 'Milestone', nextDue: '2026-10-19T23:30:00.000Z', milestones: [milestone(1)] }),
    ];
    expect(titles(sortTasks(tasks, 'milestone', NOW, 'Europe/London'))).toEqual([
      'Plain',
      'Milestone',
    ]);
    expect(titles(sortTasks(tasks, 'milestone', NOW, 'UTC'))).toEqual(['Milestone', 'Plain']);
  });
});

describe('sortTasks by title', () => {
  it('orders A to Z regardless of case, and falls back to the id', () => {
    const tasks = [
      task({ id: 'b', title: 'water plants' }),
      task({ id: 'z', title: 'Bins' }),
      task({ id: 'a', title: 'Bins' }),
      task({ id: 'c', title: 'Boiler' }),
    ];
    const sorted = order(tasks, 'title');
    expect(titles(sorted)).toEqual(['Bins', 'Bins', 'Boiler', 'water plants']);
    expect(sorted.map((t) => t.id).slice(0, 2)).toEqual(['a', 'z']);
  });
});

describe('sortTasks by priority', () => {
  it('puts urgent first, then the earliest due, then title', () => {
    const tasks = [
      task({ title: 'Low', priority: 0, nextDue: '2026-10-01T00:00:00.000Z' }),
      task({ title: 'Urgent undated', priority: 3 }),
      task({ title: 'Urgent later', priority: 3, nextDue: '2026-11-01T00:00:00.000Z' }),
      task({ title: 'Urgent sooner', priority: 3, nextDue: '2026-10-05T00:00:00.000Z' }),
      task({ title: 'High B', priority: 2 }),
      task({ title: 'High A', priority: 2 }),
    ];
    expect(titles(order(tasks, 'priority'))).toEqual([
      'Urgent sooner',
      'Urgent later',
      'Urgent undated',
      'High A',
      'High B',
      'Low',
    ]);
  });
});

describe('sortTasks by newest', () => {
  it('puts the most recently created first, ties by title', () => {
    const tasks = [
      task({ title: 'Old', createdAt: '2026-01-01T00:00:00.000Z' }),
      task({ title: 'B same', createdAt: '2026-10-10T00:00:00.000Z' }),
      task({ title: 'New', createdAt: '2026-10-11T00:00:00.000Z' }),
      task({ title: 'A same', createdAt: '2026-10-10T00:00:00.000Z' }),
    ];
    expect(titles(order(tasks, 'newest'))).toEqual(['New', 'A same', 'B same', 'Old']);
  });
});

describe('sortTasks', () => {
  it('returns a new array and leaves the input alone', () => {
    const tasks = [task({ title: 'B' }), task({ title: 'A' })];
    const before = [...tasks];
    for (const sort of TASK_SORTS) {
      const result = order(tasks, sort);
      expect(result).not.toBe(tasks);
    }
    expect(tasks).toEqual(before);
    expect(titles(order(tasks, 'title'))).toEqual(['A', 'B']);
    expect(titles(tasks)).toEqual(['B', 'A']);
  });

  it('handles an empty list', () => {
    expect(order([], 'due')).toEqual([]);
  });
});
