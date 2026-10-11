import type { TaskDto } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import {
  describeAssignees,
  describeAway,
  isAway,
  memberLabel,
  moveItem,
  nextUpName,
  rotationsOf,
} from './rotation.js';

const TODAY = '2026-10-11';
const names: Record<string, string> = { a: 'Alex', s: 'Sam', j: 'Jo' };
const nameOf = (id: string) => names[id] ?? 'Anyone';
const task = (overrides: Partial<TaskDto>): TaskDto =>
  ({
    assignmentMode: 'rotation',
    assigneeIds: ['a', 's'],
    nextAssigneeId: 's',
    archived: false,
    ...overrides,
  }) as TaskDto;

describe('isAway', () => {
  it('is inclusive of the last day away and false once back', () => {
    expect(isAway({ awayUntil: null }, TODAY)).toBe(false);
    expect(isAway({ awayUntil: '2026-10-10' }, TODAY)).toBe(false);
    expect(isAway({ awayUntil: '2026-10-11' }, TODAY)).toBe(true);
    expect(isAway({ awayUntil: '2026-10-14' }, TODAY)).toBe(true);
  });
});

describe('describeAway and memberLabel', () => {
  it('names the date while the member is away', () => {
    expect(describeAway({ awayUntil: '2026-10-14' }, TODAY)).toBe('Away until Wed 14 Oct');
    expect(memberLabel({ name: 'Sam', awayUntil: '2026-10-14' }, TODAY)).toBe(
      'Sam (away until Wed 14 Oct)',
    );
  });

  it('adds the year for a date in another year', () => {
    expect(describeAway({ awayUntil: '2027-01-02' }, TODAY)).toBe('Away until Sat 2 Jan 2027');
  });

  it('says nothing when not away or already back', () => {
    expect(describeAway({ awayUntil: null }, TODAY)).toBe('');
    expect(describeAway({ awayUntil: '2026-10-01' }, TODAY)).toBe('');
    expect(memberLabel({ name: 'Sam', awayUntil: null }, TODAY)).toBe('Sam');
    expect(memberLabel({ name: 'Sam', awayUntil: '2026-10-01' }, TODAY)).toBe('Sam');
  });
});

describe('moveItem', () => {
  it('moves an item up or down without changing the original', () => {
    const list = ['a', 'b', 'c'];
    expect(moveItem(list, 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(list, 1, 1)).toEqual(['a', 'c', 'b']);
    expect(list).toEqual(['a', 'b', 'c']);
  });

  it('leaves the order alone at either end or for a missing item', () => {
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 5, -1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], -1, 1)).toEqual(['a', 'b']);
  });
});

describe('rotationsOf', () => {
  it('keeps live rotation tasks that include the member', () => {
    const mine = task({});
    const tasks = [
      mine,
      task({ assigneeIds: ['j'] }),
      task({ archived: true }),
      task({ assignmentMode: 'fixed' }),
    ];
    expect(rotationsOf(tasks, 'a')).toEqual([mine]);
  });
});

describe('describeAssignees and nextUpName', () => {
  it('lists assignees in order, or anyone', () => {
    expect(describeAssignees(task({ assigneeIds: ['s', 'a'] }), nameOf)).toBe('Sam, Alex');
    expect(describeAssignees(task({ assigneeIds: [] }), nameOf)).toBe('anyone');
  });

  it('names whose turn it is on rotation tasks only', () => {
    expect(nextUpName(task({}), nameOf)).toBe('Sam');
    expect(nextUpName(task({ nextAssigneeId: null }), nameOf)).toBe('');
    expect(nextUpName(task({ assignmentMode: 'fixed' }), nameOf)).toBe('');
  });
});
