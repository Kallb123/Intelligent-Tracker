import type { MemberDto, OccurrenceDto } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import {
  describeDue,
  describePrepStart,
  dueDateOf,
  groupByAssignee,
  groupByDate,
} from './occurrences.js';

const TZ = 'Europe/London';
const TODAY = '2026-10-11';

let counter = 0;
function occ(overrides: Partial<OccurrenceDto> = {}): OccurrenceDto {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    taskId: '33333333-3333-4333-8333-333333333333',
    task: { title: 'Bins', category: null, priority: 0, allDay: true, scheduleKind: 'fixed' },
    dueDate: TODAY,
    dueAt: null,
    startAt: null,
    assigneeId: null,
    status: 'active',
    completedAt: null,
    completedBy: null,
    snoozedUntil: null,
    overdue: false,
    ...overrides,
  };
}

const member = (id: string, name: string): MemberDto => ({
  id,
  name,
  username: name.toLowerCase(),
  email: null,
  role: 'member',
  pending: false,
});

describe('dueDateOf', () => {
  it('uses the date of an all-day occurrence and the local date of a timed one', () => {
    expect(dueDateOf(occ({ dueDate: '2026-10-12' }), TZ)).toBe('2026-10-12');
    // 23:30 UTC on 11 October is already 12 October in BST.
    expect(dueDateOf(occ({ dueDate: null, dueAt: '2026-10-11T23:30:00.000Z' }), TZ)).toBe(
      '2026-10-12',
    );
    expect(dueDateOf(occ({ dueDate: null }), TZ)).toBeNull();
  });
});

describe('describeDue', () => {
  it('words the due date relative to today', () => {
    expect(describeDue(occ(), TODAY, TZ)).toBe('Due today');
    expect(describeDue(occ({ dueDate: '2026-10-12' }), TODAY, TZ)).toBe('Due tomorrow');
    expect(describeDue(occ({ dueDate: '2026-10-16' }), TODAY, TZ)).toBe('Due Fri 16 Oct');
    expect(describeDue(occ({ dueDate: null }), TODAY, TZ)).toBe('No date');
  });

  it('flags overdue ones and shows the time of a timed one', () => {
    expect(describeDue(occ({ dueDate: '2026-10-05', overdue: true }), TODAY, TZ)).toBe(
      'Overdue, was due Mon 5 Oct',
    );
    const timed = occ({
      task: { title: 'Call', category: null, priority: 0, allDay: false, scheduleKind: 'once' },
      dueDate: null,
      dueAt: '2026-10-11T08:00:00.000Z',
      overdue: true,
    });
    expect(describeDue(timed, TODAY, TZ)).toBe('Overdue, was due today at 09:00');
  });
});

describe('describePrepStart', () => {
  it('announces a prep window that opens before the due date', () => {
    const later = occ({ dueDate: '2026-10-30', startAt: '2026-10-15T23:00:00.000Z' });
    expect(describePrepStart(later, TODAY, TZ)).toBe('Prep starts Fri 16 Oct');
    const open = occ({ dueDate: '2026-10-30', startAt: '2026-10-05T23:00:00.000Z' });
    expect(describePrepStart(open, TODAY, TZ)).toBe('Prep started Tue 6 Oct');
  });

  it('says nothing without a lead time, or when the window opens on the due day', () => {
    expect(describePrepStart(occ(), TODAY, TZ)).toBe('');
    const sameDay = occ({ dueDate: '2026-10-12', startAt: '2026-10-11T23:00:00.000Z' });
    expect(describePrepStart(sameDay, TODAY, TZ)).toBe('');
    const undated = occ({ dueDate: null, startAt: '2026-10-05T23:00:00.000Z' });
    expect(describePrepStart(undated, TODAY, TZ)).toBe('');
  });
});

describe('groupByAssignee', () => {
  const alex = member('a1', 'Alex');
  const sam = member('s1', 'Sam');

  it('puts the logged-in member first, then the others, then Anyone', () => {
    const items = [
      occ({ assigneeId: 's1' }),
      occ({ assigneeId: null }),
      occ({ assigneeId: 'a1' }),
      occ({ assigneeId: 's1' }),
    ];
    const groups = groupByAssignee(items, [sam, alex], 'a1');

    expect(groups.map((g) => [g.name, g.occurrences.length])).toEqual([
      ['Alex (you)', 1],
      ['Sam', 2],
      ['Anyone', 1],
    ]);
  });

  it('leaves out empty groups and files unknown assignees under Anyone', () => {
    const groups = groupByAssignee([occ({ assigneeId: 'gone' })], [alex, sam], 'a1');
    expect(groups.map((g) => g.name)).toEqual(['Anyone']);
    expect(groupByAssignee([], [alex], 'a1')).toEqual([]);
  });
});

describe('groupByDate', () => {
  it('groups by local due date in order of appearance', () => {
    const a = occ({ dueDate: '2026-10-12' });
    const b = occ({ dueDate: '2026-10-13' });
    const c = occ({ dueDate: null, dueAt: '2026-10-12T20:00:00.000Z' });
    const groups = groupByDate([a, b, c], TZ);

    expect(groups.map((g) => [g.date, g.occurrences])).toEqual([
      ['2026-10-12', [a, c]],
      ['2026-10-13', [b]],
    ]);
  });
});
