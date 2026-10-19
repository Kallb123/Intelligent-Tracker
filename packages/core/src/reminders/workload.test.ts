import { HOUSEHOLD_DEFAULTS } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { allDay, at, timed } from '../recurrence/test-util.js';
import { RecurrenceError } from '../recurrence/errors.js';
import { planReminders, type PlanRemindersInput } from './planner.js';
import { smoothReminderPlans, type WorkloadPlanInput, type ReservedHeadsUp } from './workload.js';

function entry(id: string, overrides: Partial<PlanRemindersInput> = {}): WorkloadPlanInput {
  return {
    id,
    householdId: 'home',
    input: {
      occurrence: {
        due: allDay('2026-11-01'),
        status: 'upcoming',
        assigneeId: 'alex',
        snoozedUntil: null,
      },
      task: {
        leadTimeDays: 14,
        reminderProfile: 'gentle',
        reminderSlot: 'evening',
        reminderCustomTime: null,
        milestones: [],
      },
      household: {
        morningSlot: '08:00',
        eveningSlot: '19:00',
        quietHours: { ...HOUSEHOLD_DEFAULTS.quietHours },
      },
      now: at('2026-10-01T09:00:00Z'),
      ...overrides,
    },
  };
}
const head = (plan: ReturnType<typeof planReminders>) => plan.find((r) => r.kind === 'heads_up');
const time = (plans: ReturnType<typeof smoothReminderPlans>, id: string) =>
  head(plans.get(id)!)?.fireAt.toISOString();
const reservation = (day: string, memberId: string | null = 'alex'): ReservedHeadsUp => ({
  householdId: 'home',
  timezone: 'Europe/London',
  memberId,
  fireAt: at(`${day}T18:00:00Z`),
});

describe('workload smoothing', () => {
  it('staggers a cluster by local day, with stable keys and unchanged other reminders/inputs', () => {
    const entries = ['c', 'a', 'b'].map((id) => entry(id));
    const before = structuredClone(entries);
    const plans = smoothReminderPlans(entries);
    expect(time(plans, 'a')).toBe('2026-10-18T18:00:00.000Z');
    expect(time(plans, 'b')).toBe('2026-10-19T18:00:00.000Z');
    expect(time(plans, 'c')).toBe('2026-10-20T18:00:00.000Z');
    for (const e of entries) {
      expect(plans.get(e.id)?.filter((r) => r.kind !== 'heads_up')).toEqual(
        planReminders(e.input).filter((r) => r.kind !== 'heads_up'),
      );
      expect(head(plans.get(e.id)!)).toMatchObject({ key: 'heads_up', memberId: 'alex' });
    }
    expect(entries).toEqual(before);
    expect(smoothReminderPlans([...entries].reverse())).toEqual(plans);
  });

  it('balances more than seven heads-ups without leaving the first week', () => {
    const plans = smoothReminderPlans(
      Array.from({ length: 15 }, (_, i) => entry(String(i).padStart(2, '0'))),
    );
    const days = [...plans.values()].map((p) => head(p)!.fireAt.toISOString().slice(0, 10));
    expect([...new Set(days)].sort()).toEqual(
      Array.from({ length: 7 }, (_, i) => `2026-10-${18 + i}`),
    );
    expect(Math.max(...days.map((day) => days.filter((d) => d === day).length))).toBe(3);
  });

  it('gives narrow windows priority and leaves milestones, nudges and due reminders in place', () => {
    const wide = entry('a');
    const tight = entry('b', {
      task: {
        ...wide.input.task,
        milestones: [{ id: 'm', title: 'Book', offsetDaysBeforeDue: 14 }],
      },
    });
    const standard = entry('c', {
      task: { ...wide.input.task, reminderProfile: 'standard', leadTimeDays: 2 },
      occurrence: { ...wide.input.occurrence, due: allDay('2026-10-20') },
    });
    const plans = smoothReminderPlans([wide, tight, standard]);
    expect(time(plans, 'b')).toBe('2026-10-18T18:00:00.000Z');
    expect(time(plans, 'c')).toBe('2026-10-18T18:00:00.000Z');
    expect(time(plans, 'a')).toBe('2026-10-19T18:00:00.000Z');
  });

  it('keeps people and households independent while broadcasts count against everyone', () => {
    const a = entry('a');
    const b = entry('b', { occurrence: { ...a.input.occurrence, assigneeId: 'sam' } });
    const c = { ...entry('c'), householdId: 'other' };
    const broadcast = entry('d', { occurrence: { ...a.input.occurrence, assigneeId: null } });
    const plans = smoothReminderPlans([a, b, c, broadcast]);
    expect(time(plans, 'a')).toEqual(time(plans, 'b'));
    expect(time(plans, 'a')).toEqual(time(plans, 'c'));
    expect(time(plans, 'd')).toBe('2026-10-19T18:00:00.000Z');
    expect(time(smoothReminderPlans([a], [reservation('2026-10-18', null)]), 'a')).toBe(
      '2026-10-19T18:00:00.000Z',
    );
  });

  it('respects existing reservations and naturally separate windows', () => {
    const a = entry('a');
    const b = entry('b', { task: { ...a.input.task, leadTimeDays: 12 } });
    const plans = smoothReminderPlans(
      [b, a],
      [reservation('2026-10-18'), reservation('2026-10-19')],
    );
    expect(time(plans, 'a')).toBe('2026-10-20T18:00:00.000Z');
    expect(time(plans, 'b')).toBe('2026-10-21T18:00:00.000Z');
  });

  it('preserves the local slot across the autumn clock change', () => {
    const a = entry('a');
    a.input.task.leadTimeDays = 7;
    const b = entry('b', { task: a.input.task });
    const plans = smoothReminderPlans([a, b]);
    expect(time(plans, 'a')).toBe('2026-10-25T19:00:00.000Z');
    expect(time(plans, 'b')).toBe('2026-10-26T19:00:00.000Z');
    // The last BST day to the first GMT day is 25 hours, still 19:00 local.
    a.input.task.leadTimeDays = 8;
    expect(time(smoothReminderPlans([a, b]), 'b')).toBe('2026-10-25T19:00:00.000Z');
  });

  it('uses custom slots and quiet-hour adjustments on each candidate day', () => {
    const a = entry('a');
    a.input.task.reminderSlot = 'custom_time';
    a.input.task.reminderCustomTime = '23:00';
    const b = entry('b', { task: a.input.task });
    const plans = smoothReminderPlans([a, b]);
    expect(time(plans, 'a')).toBe('2026-10-19T07:00:00.000Z');
    expect(time(plans, 'b')).toBe('2026-10-20T07:00:00.000Z');
  });

  it('does not smooth snoozes or active away holds', () => {
    const a = entry('a');
    const b = entry('b', {
      occurrence: { ...a.input.occurrence, snoozedUntil: at('2026-10-20T18:00:00Z') },
    });
    const c = entry('c', { assignee: { awayUntil: '2026-10-19' } });
    const d = entry('d', { assignee: { awayUntil: '2026-09-30' } });
    const plans = smoothReminderPlans([b, c, a, d]);
    expect(plans.get('b')).toEqual(planReminders(b.input));
    expect(plans.get('c')).toEqual(planReminders(c.input));
    expect(time(plans, 'd')).toBe('2026-10-19T18:00:00.000Z');
  });

  it('does not invent heads-ups for silent, done, undated, no-lead or already-open tasks', () => {
    const a = entry('a');
    const entries = [
      entry('silent', { task: { ...a.input.task, reminderProfile: 'silent' } }),
      entry('done', { occurrence: { ...a.input.occurrence, status: 'done' } }),
      entry('undated', { occurrence: { ...a.input.occurrence, due: null } }),
      entry('no-lead', { task: { ...a.input.task, leadTimeDays: null } }),
      entry('past', { now: at('2026-10-19T09:00:00Z') }),
    ];
    const plans = smoothReminderPlans(entries);
    for (const e of entries) expect(plans.get(e.id)).toEqual(planReminders(e.input));
    expect(smoothReminderPlans([])).toEqual(new Map());
  });

  it('retains an outstanding saved offset after the original start is past', () => {
    const e = entry('a', { now: at('2026-10-19T09:00:00Z'), headsUpDelayDays: 2 });
    const plans = smoothReminderPlans([e], [reservation('2026-10-19')]);
    expect(time(plans, 'a')).toBe('2026-10-20T18:00:00.000Z');
    expect(head(plans.get('a')!)?.headsUpDelayDays).toBe(2);
  });
});

describe('saved smoothing offsets', () => {
  it.each([-1, 7, 0.5, NaN])('rejects invalid offset %s', (headsUpDelayDays) => {
    expect(() => planReminders(entry('a', { headsUpDelayDays }).input)).toThrow(RecurrenceError);
  });
  it('ignores an offset when the task has no lead', () => {
    const e = entry('a', { headsUpDelayDays: 2 });
    e.input.task.leadTimeDays = null;
    expect(head(planReminders(e.input))).toBeUndefined();
  });
  it('keeps an earlier milestone in place while staggering a later heads-up', () => {
    const e = entry('a', { headsUpDelayDays: 2 });
    e.input.task.milestones = [{ id: 'early', title: 'Gather papers', offsetDaysBeforeDue: 20 }];
    const plan = planReminders(e.input);
    expect(plan.find((r) => r.kind === 'milestone')?.fireAt.toISOString()).toBe(
      '2026-10-12T18:00:00.000Z',
    );
    expect(head(plan)?.fireAt.toISOString()).toBe('2026-10-20T18:00:00.000Z');
  });
  it('never delays onto the due day, a nudge, a milestone or an event-before reminder', () => {
    const e = entry('a', { headsUpDelayDays: 6 });
    e.input.task.leadTimeDays = 1;
    expect(head(planReminders(e.input))?.headsUpDelayDays).toBeUndefined();
    e.input.task.leadTimeDays = 7;
    e.input.task.remindOffsetDays = -2;
    expect(head(planReminders(e.input))?.headsUpDelayDays).toBeUndefined();
    e.input.task.remindOffsetDays = 0;
    e.input.occurrence.due = timed('2026-11-01T09:00:00Z');
    expect(head(planReminders(e.input))?.headsUpDelayDays).toBeUndefined();
  });
});
