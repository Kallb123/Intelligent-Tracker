import type { MemberDto, OccurrenceDto } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import {
  describeDue,
  describeNextDue,
  describeNextMilestone,
  describePrepStart,
  dueDateOf,
  groupByAssignee,
  groupByDate,
  nextDueDate,
  nextMilestone,
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
  awayUntil: null,
  telegramLinked: false,
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

describe('describeNextDue', () => {
  // 11:00 on TODAY in London (BST).
  const now = new Date('2026-10-11T10:00:00.000Z');
  const allDay = (nextDue: string | null) => describeNextDue({ nextDue, allDay: true }, now, TZ);
  const timed = (nextDue: string) => describeNextDue({ nextDue, allDay: false }, now, TZ);

  it('words the date of the next occurrence relative to today, in the household zone', () => {
    expect(allDay('2026-10-10T23:00:00.000Z')).toBe('Next due today');
    expect(allDay('2026-10-11T23:00:00.000Z')).toBe('Next due tomorrow');
    expect(allDay('2026-10-15T23:00:00.000Z')).toBe('Next due Fri 16 Oct');
  });

  it('flags an all-day date before today, and says nothing without one', () => {
    expect(allDay('2026-10-04T23:00:00.000Z')).toBe('Next due Mon 5 Oct, overdue');
    expect(allDay(null)).toBe('');
  });

  it('adds the time of a timed due, and flags it overdue once that has passed', () => {
    expect(timed('2026-10-11T08:30:00.000Z')).toBe('Next due today at 09:30, overdue');
    expect(timed('2026-10-11T14:00:00.000Z')).toBe('Next due today at 15:00');
    expect(timed('2026-10-12T08:30:00.000Z')).toBe('Next due tomorrow at 09:30');
  });
});

describe('nextDueDate', () => {
  it('is the due day in the household zone, which can differ from the UTC day', () => {
    const nextDue = '2026-10-20T23:30:00.000Z'; // 00:30 BST on 21 Oct in London
    expect(nextDueDate({ nextDue }, TZ)).toBe('2026-10-21');
    expect(nextDueDate({ nextDue }, 'UTC')).toBe('2026-10-20');
  });

  it('is null without a next occurrence', () => {
    expect(nextDueDate({ nextDue: null }, TZ)).toBeNull();
  });
});

describe('nextMilestone and describeNextMilestone', () => {
  // 11:00 on TODAY in London (BST); the due date is Fri 30 Oct, local midnight (GMT by then).
  const now = new Date('2026-10-11T10:00:00.000Z');
  const nextDue = '2026-10-30T00:00:00.000Z';
  const ms = (title: string, offsetDaysBeforeDue: number) => ({
    id: `id-${title}`,
    title,
    offsetDaysBeforeDue,
  });
  const next = (milestones: ReturnType<typeof ms>[], due: string | null = nextDue) =>
    nextMilestone({ nextDue: due, milestones }, now, TZ);
  const describeMilestone = (milestones: ReturnType<typeof ms>[], due: string | null = nextDue) =>
    describeNextMilestone({ nextDue: due, milestones }, now, TZ);

  it('dates each milestone before the due date in the household zone', () => {
    expect(next([ms('Book venue', 7)])).toEqual({ title: 'Book venue', date: '2026-10-23' });
    expect(next([ms('On the day', 0)])).toEqual({ title: 'On the day', date: '2026-10-30' });
  });

  it('dates a milestone from the due day in the given zone', () => {
    // 00:30 BST on 21 Oct in London, still 20 Oct in UTC.
    const lateDue = '2026-10-20T23:30:00.000Z';
    const early = new Date('2026-10-11T10:00:00.000Z');
    const onTheDay = { nextDue: lateDue, milestones: [ms('On the day', 0)] };
    expect(nextMilestone(onTheDay, early, 'Europe/London')).toEqual({
      title: 'On the day',
      date: '2026-10-21',
    });
    expect(nextMilestone(onTheDay, early, 'UTC')).toEqual({
      title: 'On the day',
      date: '2026-10-20',
    });
  });

  it('picks the earliest milestone that is today or later, the first listed on a tie', () => {
    const milestones = [ms('Passed', 30), ms('Later', 3), ms('First', 10), ms('Same day', 10)];
    expect(next(milestones)).toEqual({ title: 'First', date: '2026-10-20' });
    expect(next([ms('Passed', 30), ms('Today', 19)])).toEqual({
      title: 'Today',
      date: '2026-10-11',
    });
  });

  it('is null without a due date, milestones, or any milestone still to come', () => {
    expect(next([ms('Book venue', 7)], null)).toBeNull();
    expect(next([])).toBeNull();
    expect(next([ms('Passed', 20)])).toBeNull();
  });

  it('describes the milestone relative to today', () => {
    expect(describeMilestone([ms('Book venue', 19)])).toBe('Next milestone: Book venue, today');
    expect(describeMilestone([ms('Book venue', 18)])).toBe('Next milestone: Book venue, tomorrow');
    expect(describeMilestone([ms('Book venue', 0)])).toBe('Next milestone: Book venue, Fri 30 Oct');
  });

  it('says nothing when there is no next milestone', () => {
    expect(describeMilestone([])).toBe('');
    expect(describeMilestone([ms('Passed', 20)])).toBe('');
    expect(describeMilestone([ms('Book venue', 7)], null)).toBe('');
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
