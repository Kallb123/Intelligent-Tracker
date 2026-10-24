import type { TaskDto } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_SORT, isTaskSort, sortTasks, TASK_SORT_OPTIONS, TASK_SORTS } from './sort.js';

let counter = 0;
const task = (overrides: Partial<TaskDto>): TaskDto => {
  counter += 1;
  return {
    id: `id-${String(counter).padStart(3, '0')}`,
    title: 'Task',
    priority: 0,
    nextDue: null,
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
    expect(titles(sortTasks(tasks, 'due'))).toEqual(['Overdue', 'Soon', 'Later', 'Undated']);
  });

  it('compares instants, not strings', () => {
    const tasks = [
      task({ title: 'B', nextDue: '2026-10-12T10:00:00.000Z' }),
      task({ title: 'A', nextDue: '2026-10-12T09:30:00.000Z' }),
    ];
    expect(titles(sortTasks(tasks, 'due'))).toEqual(['A', 'B']);
  });

  it('breaks ties by title, including among undated tasks', () => {
    const tasks = [
      task({ title: 'Zeta', nextDue: '2026-10-12T00:00:00.000Z' }),
      task({ title: 'Mu' }),
      task({ title: 'Alpha', nextDue: '2026-10-12T00:00:00.000Z' }),
      task({ title: 'Beta' }),
    ];
    expect(titles(sortTasks(tasks, 'due'))).toEqual(['Alpha', 'Zeta', 'Beta', 'Mu']);
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
    const sorted = sortTasks(tasks, 'title');
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
    expect(titles(sortTasks(tasks, 'priority'))).toEqual([
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
    expect(titles(sortTasks(tasks, 'newest'))).toEqual(['New', 'A same', 'B same', 'Old']);
  });
});

describe('sortTasks', () => {
  it('returns a new array and leaves the input alone', () => {
    const tasks = [task({ title: 'B' }), task({ title: 'A' })];
    const before = [...tasks];
    for (const sort of TASK_SORTS) {
      const sorted = sortTasks(tasks, sort);
      expect(sorted).not.toBe(tasks);
    }
    expect(tasks).toEqual(before);
    expect(titles(sortTasks(tasks, 'title'))).toEqual(['A', 'B']);
    expect(titles(tasks)).toEqual(['B', 'A']);
  });

  it('handles an empty list', () => {
    expect(sortTasks([], 'due')).toEqual([]);
  });
});
