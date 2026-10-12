import { HOUSEHOLD_DEFAULTS } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { RecurrenceError } from '../recurrence/errors.js';
import { allDay, at, timed } from '../recurrence/test-util.js';
import { DEFAULT_OVERDUE_HORIZON_DAYS, planReminders, type PlanRemindersInput } from './index.js';

const household = {
  morningSlot: HOUSEHOLD_DEFAULTS.slots.morningDigest,
  eveningSlot: HOUSEHOLD_DEFAULTS.slots.eveningDigest,
  quietHours: { ...HOUSEHOLD_DEFAULTS.quietHours },
};

type Overrides = {
  occurrence?: Partial<PlanRemindersInput['occurrence']>;
  task?: Partial<PlanRemindersInput['task']>;
  household?: Partial<PlanRemindersInput['household']>;
  assignee?: PlanRemindersInput['assignee'];
  now?: Date;
  overdueHorizonDays?: number;
};

/** A standard, evening-slot task due 2026-11-01 (a Sunday, in GMT) with no lead time. */
function input(o: Overrides = {}): PlanRemindersInput {
  return {
    occurrence: {
      due: allDay('2026-11-01'),
      status: 'active',
      assigneeId: 'alex',
      snoozedUntil: null,
      ...o.occurrence,
    },
    task: {
      leadTimeDays: null,
      reminderProfile: 'standard',
      reminderSlot: 'evening',
      reminderCustomTime: null,
      milestones: [],
      ...o.task,
    },
    household: { ...household, ...o.household },
    now: o.now ?? at('2026-09-01T09:00:00Z'),
    ...(o.assignee !== undefined && { assignee: o.assignee }),
    ...(o.overdueHorizonDays !== undefined && { overdueHorizonDays: o.overdueHorizonDays }),
  };
}

/** `kind ISO-instant-to-the-minute`, for readable table rows. */
const show = (o: Overrides) =>
  planReminders(input(o)).map((r) => `${r.kind} ${r.fireAt.toISOString().slice(0, 16)}Z`);

/** Car insurance, PLAN.md section 9: yearly on 1 Nov, 30 days' lead, three milestones. */
const carInsurance: Overrides['task'] = {
  leadTimeDays: 30,
  milestones: [
    { id: 'quotes', title: 'Get quotes', offsetDaysBeforeDue: 30 },
    { id: 'decide', title: 'Decide', offsetDaysBeforeDue: 14 },
    { id: 'renew', title: 'Renew', offsetDaysBeforeDue: 7 },
  ],
};

describe('car insurance (PLAN.md section 9)', () => {
  // BST ends on 25 Oct 2026: 19:00 London is 18:00Z before it and 19:00Z from then on.
  const plan = (o: Overrides = {}) =>
    show({
      overdueHorizonDays: 70,
      ...o,
      task: { ...carInsurance, ...o.task },
    });

  it('plans heads-up, milestones, nudges, the due day and overdue reminders', () => {
    expect(plan()).toEqual([
      'heads_up 2026-10-02T18:00Z',
      'milestone 2026-10-02T18:00Z', // Get quotes: same slot as the heads-up, both returned
      'nudge 2026-10-17T18:00Z', // 50% of the window
      'milestone 2026-10-18T18:00Z', // Decide
      // The 75% nudge (round(22.5) = day 23) falls on 25 Oct, which has the Renew milestone.
      'milestone 2026-10-25T19:00Z', // Renew
      'nudge 2026-10-29T19:00Z', // 90%
      'due 2026-11-01T19:00Z',
      'overdue 2026-11-02T19:00Z',
      'overdue 2026-11-05T19:00Z',
      'overdue 2026-11-08T19:00Z',
    ]);
  });

  it('gives each reminder a stable key, the assignee and milestone details', () => {
    const planned = planReminders(
      input({ task: carInsurance, overdueHorizonDays: 70, occurrence: { assigneeId: 'alex' } }),
    );
    expect(planned.map((r) => r.key)).toEqual([
      'heads_up',
      'milestone:quotes',
      'nudge:2026-10-17',
      'milestone:decide',
      'milestone:renew',
      'nudge:2026-10-29',
      'due',
      'overdue:2026-11-02',
      'overdue:2026-11-05',
      'overdue:2026-11-08',
    ]);
    expect(planned.every((r) => r.memberId === 'alex')).toBe(true);
    expect(planned[1]).toMatchObject({
      kind: 'milestone',
      milestoneId: 'quotes',
      milestoneTitle: 'Get quotes',
    });
    expect(planned[1]).not.toHaveProperty('overdueDays');
    expect(planned.at(-1)).toMatchObject({ kind: 'overdue', overdueDays: 7 });
    expect(planned.at(-1)).not.toHaveProperty('milestoneId');
    expect(planned[0]).not.toHaveProperty('milestoneId');
    expect(planned[0]).not.toHaveProperty('overdueDays');
  });

  it('keeps the milestones but nudges less once Started', () => {
    const started = plan({ occurrence: { status: 'started' } });
    expect(started.filter((r) => r.startsWith('nudge'))).toEqual([]);
    expect(started.filter((r) => r.startsWith('milestone'))).toHaveLength(3);
  });

  it('skips a milestone that is completed', () => {
    const planned = plan({ occurrence: { completedMilestoneIds: ['quotes'] } });
    expect(planned.filter((r) => r.startsWith('milestone'))).toEqual([
      'milestone 2026-10-18T18:00Z',
      'milestone 2026-10-25T19:00Z',
    ]);
  });

  it('leaves the group unassigned when the occurrence has no assignee', () => {
    const planned = planReminders(input({ task: carInsurance, occurrence: { assigneeId: null } }));
    expect(planned.every((r) => r.memberId === null)).toBe(true);
  });
});

describe('profiles', () => {
  // Lead 10 days before 1 Nov: window starts 22 Oct. now is 1 Oct; overdue reaches 6 Nov.
  const profile = (reminderProfile: PlanRemindersInput['task']['reminderProfile']) =>
    show({
      task: { leadTimeDays: 10, reminderProfile },
      now: at('2026-10-01T09:00:00Z'),
      overdueHorizonDays: 36,
    });

  it.each([
    ['silent', []],
    ['gentle', ['heads_up 2026-10-22T18:00Z', 'due 2026-11-01T19:00Z']],
    [
      'standard',
      [
        'heads_up 2026-10-22T18:00Z',
        'nudge 2026-10-27T19:00Z', // 50%
        'nudge 2026-10-30T19:00Z', // 75%: round(7.5) = day 8
        'nudge 2026-10-31T19:00Z', // 90%
        'due 2026-11-01T19:00Z',
        'overdue 2026-11-02T19:00Z',
        'overdue 2026-11-05T19:00Z', // every 3 days
      ],
    ],
    [
      'persistent',
      [
        'heads_up 2026-10-22T18:00Z',
        'nudge 2026-10-25T19:00Z', // 25%: round(2.5) = day 3
        'nudge 2026-10-27T19:00Z',
        'nudge 2026-10-30T19:00Z',
        'nudge 2026-10-31T19:00Z',
        'due 2026-11-01T19:00Z',
        'overdue 2026-11-02T19:00Z', // daily
        'overdue 2026-11-03T19:00Z',
        'overdue 2026-11-04T19:00Z',
        'overdue 2026-11-05T19:00Z',
      ],
    ],
  ] as const)('%s', (name, expected) => {
    expect(profile(name)).toEqual(expected);
  });

  it.each([
    [
      'persistent',
      ['nudge 2026-10-27T19:00Z', 'nudge 2026-10-30T19:00Z', 'nudge 2026-10-31T19:00Z'],
    ],
    ['standard', []],
    ['gentle', []],
  ] as const)('Started turns %s nudges down a level', (reminderProfile, nudges) => {
    const planned = show({
      task: { leadTimeDays: 10, reminderProfile },
      occurrence: { status: 'started' },
      now: at('2026-10-01T09:00:00Z'),
    });
    expect(planned.filter((r) => r.startsWith('nudge'))).toEqual(nudges);
    expect(planned).toContain('heads_up 2026-10-22T18:00Z');
    expect(planned).toContain('due 2026-11-01T19:00Z');
  });

  it('keeps the persistent overdue reminders unaffected by Started', () => {
    const planned = show({
      task: { reminderProfile: 'persistent' },
      occurrence: { status: 'started' },
      now: at('2026-11-01T20:00:00Z'),
      overdueHorizonDays: 2,
    });
    expect(planned).toEqual(['overdue 2026-11-02T19:00Z', 'overdue 2026-11-03T19:00Z']);
  });

  it('has no heads-up or nudges without a lead time, or with a lead time of 0', () => {
    expect(show({ overdueHorizonDays: 0 })).toEqual(['due 2026-11-01T19:00Z']);
    expect(show({ task: { leadTimeDays: 0 }, overdueHorizonDays: 0 })).toEqual([
      'due 2026-11-01T19:00Z',
    ]);
  });

  it('plans at most one nudge per day', () => {
    // Lead 3: the 25% / 50% / 75% fractions round to days 1, 2 and 2; 90% is the due day.
    expect(
      show({
        task: { leadTimeDays: 3, reminderProfile: 'persistent' },
        overdueHorizonDays: 0,
      }),
    ).toEqual([
      'heads_up 2026-10-29T19:00Z',
      'nudge 2026-10-30T19:00Z',
      'nudge 2026-10-31T19:00Z',
      'due 2026-11-01T19:00Z',
    ]);
  });
});

describe('nothing to remind about', () => {
  it.each([
    ['done', { status: 'done' }],
    ['skipped', { status: 'skipped' }],
    ['undated', { due: null }],
  ] as const)('an occurrence that is %s', (_name, occurrence) => {
    expect(show({ task: carInsurance, occurrence })).toEqual([]);
  });

  it('a silent task, whatever it carries', () => {
    expect(show({ task: { ...carInsurance, reminderProfile: 'silent' } })).toEqual([]);
  });
});

describe('bin night (evening before)', () => {
  // Tuesday 6 Oct 2026: put the bins out on Monday evening, 19:00 BST = 18:00Z.
  const bins: Overrides = {
    occurrence: { due: allDay('2026-10-06') },
    task: { reminderProfile: 'gentle', remindOffsetDays: -1 },
    now: at('2026-10-01T09:00:00Z'),
  };

  it('reminds on the evening before the due day', () => {
    expect(show(bins)).toEqual(['due 2026-10-05T18:00Z']);
  });

  it('reminds on the due day itself without an offset', () => {
    expect(show({ ...bins, task: { reminderProfile: 'gentle' } })).toEqual([
      'due 2026-10-06T18:00Z',
    ]);
  });

  it('still counts overdue from the due day, not from the reminder', () => {
    expect(show({ ...bins, task: { remindOffsetDays: -1 } })).toEqual([
      'due 2026-10-05T18:00Z',
      'overdue 2026-10-07T18:00Z',
      'overdue 2026-10-10T18:00Z',
      'overdue 2026-10-13T18:00Z',
    ]);
  });
});

describe('slots', () => {
  const gentle = (o: Overrides) =>
    show({ task: { reminderProfile: 'gentle' }, now: at('2026-10-01T09:00:00Z'), ...o });

  it('uses the household morning slot, evening slot or the custom time', () => {
    const due = { occurrence: { due: allDay('2026-11-10') } };
    expect(
      gentle({ ...due, task: { reminderProfile: 'gentle', reminderSlot: 'morning' } }),
    ).toEqual(['due 2026-11-10T08:00Z']);
    expect(gentle(due)).toEqual(['due 2026-11-10T19:00Z']);
    expect(
      gentle({
        ...due,
        task: {
          reminderProfile: 'gentle',
          reminderSlot: 'custom_time',
          reminderCustomTime: '07:45',
        },
      }),
    ).toEqual(['due 2026-11-10T07:45Z']);
  });

  it('accepts HH:MM:SS times, as Postgres time columns return them', () => {
    expect(
      gentle({
        occurrence: { due: allDay('2026-11-10') },
        task: {
          reminderProfile: 'gentle',
          reminderSlot: 'custom_time',
          reminderCustomTime: '20:15:30',
        },
        household: { eveningSlot: '19:00:00', quietHours: { start: '21:30:00', end: '07:30:00' } },
      }),
    ).toEqual(['due 2026-11-10T20:15Z']);
    expect(
      planReminders(
        input({
          occurrence: { due: allDay('2026-11-10') },
          task: {
            reminderProfile: 'gentle',
            reminderSlot: 'custom_time',
            reminderCustomTime: '20:15:30',
          },
        }),
      )[0]?.fireAt.toISOString(),
    ).toBe('2026-11-10T20:15:30.000Z');
  });

  it('uses the household time zone', () => {
    // 19:00 EST (UTC-5) on 10 Nov is 00:00Z on the 11th.
    expect(
      gentle({
        occurrence: { due: allDay('2026-11-10') },
        household: { timezone: 'America/New_York' },
      }),
    ).toEqual(['due 2026-11-11T00:00Z']);
  });
});

describe('timed dues', () => {
  const dentist = (isoDue: string, o: Overrides = {}) =>
    show({
      occurrence: { due: timed(isoDue) },
      task: { reminderProfile: 'gentle', ...o.task },
      now: at('2026-10-01T09:00:00Z'),
      ...(o.household && { household: o.household }),
    });

  it('reminds at the evening slot of the day before a 14:00 appointment', () => {
    // 14:00 BST on 14 Oct is 13:00Z; 19:00 on the 14th would be after it.
    expect(dentist('2026-10-14T13:00:00Z')).toEqual(['due 2026-10-13T18:00Z']);
  });

  it('reminds on the due day when the slot is before the due time', () => {
    expect(dentist('2026-10-14T13:00:00Z', { task: { reminderSlot: 'morning' } })).toEqual([
      'due 2026-10-14T07:00Z',
    ]);
    // 21:00 BST: the 19:00 slot comes first.
    expect(dentist('2026-10-14T20:00:00Z')).toEqual(['due 2026-10-14T18:00Z']);
  });

  it('applies remindOffsetDays to a timed due', () => {
    const offset = (reminderSlot: 'morning' | 'evening', remindOffsetDays?: number) =>
      dentist('2026-10-14T13:00:00Z', {
        task: { reminderSlot, ...(remindOffsetDays !== undefined && { remindOffsetDays }) },
      });
    expect(offset('morning')).toEqual(['due 2026-10-14T07:00Z']);
    expect(offset('morning', -1)).toEqual(['due 2026-10-13T07:00Z']);
    expect(offset('evening', -1)).toEqual(['due 2026-10-13T18:00Z']);
  });

  it('judges a timed due on the time the reminder will really fire, after quiet hours', () => {
    // Due 07:00; the 06:00 custom time is quiet and moves to 08:00, which is too late.
    const early = (due: string) =>
      dentist(due, {
        task: { reminderSlot: 'custom_time', reminderCustomTime: '06:00' },
      });
    expect(early('2026-11-10T07:00:00Z')).toEqual(['due 2026-11-09T08:00Z']);
    expect(early('2026-11-10T09:00:00Z')).toEqual(['due 2026-11-10T08:00Z']);
  });

  it('sends no due reminder when quiet hours push even the day before past the due time', () => {
    // Quiet 22:00-07:00, custom time 23:00, due 06:00 on 10 Nov: the 10th at 23:00 and the 9th
    // at 23:00 both move to after 07:00 on the 10th, later than the due time.
    const quiet = {
      task: { reminderSlot: 'custom_time', reminderCustomTime: '23:00' },
      household: { quietHours: { start: '22:00', end: '07:00' } },
    } as const;
    expect(dentist('2026-11-10T06:00:00Z', quiet)).toEqual([]);
    // A later due time still gets the reminder, at the first slot after the quiet hours.
    expect(dentist('2026-11-10T09:00:00Z', quiet)).toEqual(['due 2026-11-10T08:00Z']);
  });

  it('is not early when the slot is exactly the due time', () => {
    expect(dentist('2026-10-14T18:00:00Z')).toEqual(['due 2026-10-14T18:00Z']);
  });

  it('takes the due day from the local date of the due instant', () => {
    // 00:30 BST on 15 Oct is 23:30Z on the 14th: due day is the 15th, the slot is too late.
    expect(dentist('2026-10-14T23:30:00Z')).toEqual(['due 2026-10-14T18:00Z']);
  });

  it('plans the window and overdue days from the local due day', () => {
    expect(
      show({
        occurrence: { due: timed('2026-10-14T13:00:00Z') },
        task: { leadTimeDays: 2 },
        now: at('2026-10-01T09:00:00Z'),
        overdueHorizonDays: 20,
      }),
    ).toEqual([
      'heads_up 2026-10-12T18:00Z',
      // The 50% nudge (13 Oct) is dropped: the due reminder is on that day.
      'due 2026-10-13T18:00Z',
      'overdue 2026-10-15T18:00Z',
      'overdue 2026-10-18T18:00Z',
    ]);
  });
});

describe('DST', () => {
  it('keeps the slot time across the spring change', () => {
    // 29 Mar 2026: clocks go forward at 01:00Z. 19:00 is 19:00Z on the 27th (GMT), 18:00Z after.
    expect(
      show({
        occurrence: { due: allDay('2026-03-29') },
        task: { leadTimeDays: 2 },
        now: at('2026-03-20T09:00:00Z'),
        overdueHorizonDays: 0,
      }),
    ).toEqual([
      'heads_up 2026-03-27T19:00Z',
      'nudge 2026-03-28T19:00Z',
      // 75% and 90% round to the due day itself, which is not strictly before it.
      'due 2026-03-29T18:00Z',
    ]);
  });

  it('puts a custom time that does not exist after the gap, and one that happens twice first', () => {
    const noQuiet = { quietHours: { start: '00:00', end: '00:00' } };
    const custom = (due: string) =>
      show({
        occurrence: { due: allDay(due) },
        task: {
          reminderProfile: 'gentle',
          reminderSlot: 'custom_time',
          reminderCustomTime: '01:30',
        },
        household: noQuiet,
        now: at('2026-03-01T09:00:00Z'),
      });
    expect(custom('2026-03-29')).toEqual(['due 2026-03-29T01:30Z']); // 01:30 is skipped: 02:30 BST
    expect(custom('2026-10-25')).toEqual(['due 2026-10-25T00:30Z']); // 01:30 BST, the first one
  });
});

describe('quiet hours on clock-change days', () => {
  // Clocks go forward on 29 Mar 2026 (01:00Z) and back on 25 Oct 2026 (01:00Z).
  const custom = (due: string, time: string) =>
    show({
      occurrence: { due: allDay(due) },
      task: { reminderProfile: 'gentle', reminderSlot: 'custom_time', reminderCustomTime: time },
      now: at('2026-03-01T09:00:00Z'),
    });

  it.each([
    ['2026-03-29', '22:00', 'due 2026-03-30T07:00Z'], // 22:00 BST, next morning 08:00 BST
    ['2026-03-29', '03:00', 'due 2026-03-29T07:00Z'], // 03:00 BST, same morning 08:00 BST
    ['2026-03-29', '01:30', 'due 2026-03-29T07:00Z'], // does not exist: 02:30 BST, still quiet
    ['2026-10-25', '22:00', 'due 2026-10-26T08:00Z'], // 22:00 GMT, next morning 08:00 GMT
    ['2026-10-25', '03:00', 'due 2026-10-25T08:00Z'],
    ['2026-10-25', '01:30', 'due 2026-10-25T08:00Z'], // happens twice, both quiet
  ] as const)('%s at %s fires at %s', (due, time, expected) => {
    expect(custom(due, time)).toEqual([expected]);
  });
});

describe('quiet hours', () => {
  const custom = (time: string, household: Overrides['household'] = {}) =>
    show({
      occurrence: { due: allDay('2026-11-10') },
      task: { reminderProfile: 'gentle', reminderSlot: 'custom_time', reminderCustomTime: time },
      household,
      now: at('2026-11-01T09:00:00Z'),
    });

  it.each([
    ['22:00', {}, 'due 2026-11-11T08:00Z'], // evening: the next morning slot
    ['03:00', {}, 'due 2026-11-10T08:00Z'], // after midnight: the same morning
    ['21:30', {}, 'due 2026-11-11T08:00Z'], // quiet hours start is inside
    ['07:30', {}, 'due 2026-11-10T07:30Z'], // and their end is not
    ['21:29', {}, 'due 2026-11-10T21:29Z'],
    // The morning slot is inside the quiet hours, so the evening slot is next.
    ['07:00', { morningSlot: '07:00' }, 'due 2026-11-10T19:00Z'],
    // No slot is outside them: the end of the quiet hours.
    ['23:00', { morningSlot: '06:00', eveningSlot: '22:00' }, 'due 2026-11-11T07:30Z'],
    // Quiet hours that do not wrap midnight.
    ['02:00', { quietHours: { start: '01:00', end: '05:00' } }, 'due 2026-11-10T08:00Z'],
    ['06:00', { quietHours: { start: '01:00', end: '05:00' } }, 'due 2026-11-10T06:00Z'],
    // Equal start and end: no quiet hours.
    ['23:00', { quietHours: { start: '22:00', end: '22:00' } }, 'due 2026-11-10T23:00Z'],
  ] as const)('custom time %s with %j fires at %s', (time, quietSettings, expected) => {
    expect(custom(time, quietSettings)).toEqual([expected]);
  });
});

describe('snooze', () => {
  // The standard evening reminder for 12 Nov is still to come (19:00Z); now is the morning.
  const snoozed = (snoozedUntil: Date | null, o: Overrides = {}) =>
    show({
      occurrence: { due: allDay('2026-11-12'), snoozedUntil },
      now: at('2026-11-12T10:00:00Z'),
      overdueHorizonDays: 5,
      ...o,
    });

  it('moves the held reminder nearest the snooze end to it and leaves later ones alone', () => {
    // Due (12 Nov) and the first overdue reminder (13 Nov) are held: only the later one moves.
    const planned = planReminders(
      input({
        occurrence: { due: allDay('2026-11-12'), snoozedUntil: at('2026-11-14T12:00:00Z') },
        now: at('2026-11-12T10:00:00Z'),
        overdueHorizonDays: 5,
      }),
    );
    expect(planned.map((r) => [r.key, r.fireAt.toISOString().slice(0, 16)])).toEqual([
      ['overdue:2026-11-13', '2026-11-14T12:00'],
      ['overdue:2026-11-16', '2026-11-16T19:00'],
    ]);
  });

  it('moves a snooze that lands in quiet hours (03:00) to the next slot', () => {
    expect(snoozed(at('2026-11-14T03:00:00Z'))).toEqual([
      'overdue 2026-11-14T08:00Z',
      'overdue 2026-11-16T19:00Z',
    ]);
  });

  it('drops the held reminder when another reminder already fires on the snooze day', () => {
    // Due is held to 13 Nov 12:00, but the 13 Nov overdue reminder is not held and fires that day.
    expect(snoozed(at('2026-11-13T12:00:00Z'))).toEqual([
      'overdue 2026-11-13T19:00Z',
      'overdue 2026-11-16T19:00Z',
    ]);
  });

  it('ignores a snooze that has already ended', () => {
    expect(snoozed(at('2026-11-12T10:00:00Z'))).toEqual(snoozed(null));
    expect(snoozed(at('2026-11-12T09:00:00Z'))).toEqual(snoozed(null));
  });

  it('moves the upcoming reminder, not an old heads-up from last week', () => {
    const plan = (snoozedUntil: Date | null) =>
      planReminders(
        input({
          // Heads-up on 22 Oct and nudges on 27, 30 and 31 Oct are long gone; due is tonight.
          task: { leadTimeDays: 10 },
          occurrence: { snoozedUntil },
          now: at('2026-11-01T10:00:00Z'),
          overdueHorizonDays: 0,
        }),
      );
    const snoozedPlan = plan(at('2026-11-02T12:00:00Z'));
    expect(snoozedPlan.map((r) => [r.key, r.fireAt.toISOString()])).toEqual([
      ['due', '2026-11-02T12:00:00.000Z'],
    ]);
    expect(plan(null).map((r) => r.key)).toEqual(['due']);
  });

  it('holds every milestone but only the earliest of the other reminders', () => {
    // Gentle car insurance: Decide (18 Oct), Renew (25 Oct) and the due day (1 Nov) all fall
    // before a snooze until 3 Nov; the heads-up (2 Oct) is past. Only the due reminder moves.
    expect(
      show({
        task: { ...carInsurance, reminderProfile: 'gentle' },
        occurrence: { snoozedUntil: at('2026-11-03T10:00:00Z') },
        now: at('2026-10-10T09:00:00Z'),
        overdueHorizonDays: 0,
      }),
    ).toEqual([
      'milestone 2026-11-03T10:00Z', // Decide
      'milestone 2026-11-03T10:00Z', // Renew
      'due 2026-11-03T10:00Z',
    ]);
  });

  it('keeps only the latest held reminder', () => {
    // Standard car insurance: the 17 and 29 Oct nudges and the due day are held; a snooze past
    // the due day sends the due reminder, not a stale nudge.
    expect(
      show({
        task: { ...carInsurance, milestones: [] },
        occurrence: { snoozedUntil: at('2026-11-03T10:00:00Z') },
        now: at('2026-10-10T09:00:00Z'),
        overdueHorizonDays: 0,
      }),
    ).toEqual(['due 2026-11-03T10:00Z']);
  });

  it('drops the held nudge when the native nudge of the snooze day is still to come', () => {
    // Nudges are on 27, 30 and 31 Oct. The 27th would be held to 30 Oct 10:00, but the nudge
    // of the 30th (not held) fires that day and keeps its own key.
    const planned = planReminders(
      input({
        task: { leadTimeDays: 10 },
        occurrence: { snoozedUntil: at('2026-10-30T10:00:00Z') },
        now: at('2026-10-26T09:00:00Z'),
        overdueHorizonDays: 0,
      }),
    );
    expect(planned.map((r) => [r.key, r.fireAt.toISOString().slice(0, 16)])).toEqual([
      ['nudge:2026-10-30', '2026-10-30T19:00'],
      ['nudge:2026-10-31', '2026-10-31T19:00'],
      ['due', '2026-11-01T19:00'],
    ]);
  });
});

describe('away mode', () => {
  // Due 4 Nov, assignee away until 5 Nov: held until the slot time on the 6th.
  const away = (awayUntil: string | null, o: Overrides = {}) =>
    show({
      occurrence: { due: allDay('2026-11-04') },
      assignee: { awayUntil },
      now: at('2026-11-03T10:00:00Z'),
      overdueHorizonDays: 7,
      ...o,
    });

  it('holds reminders until the evening after the last away day', () => {
    // The 4 Nov due reminder is dropped and the 5 Nov overdue one moves; 8 Nov is after the hold.
    expect(away('2026-11-05')).toEqual(['overdue 2026-11-06T19:00Z', 'overdue 2026-11-08T19:00Z']);
  });

  it('does not hold when the assignee is back, has no away date or there is no assignee', () => {
    const normal = [
      'due 2026-11-04T19:00Z',
      'overdue 2026-11-05T19:00Z',
      'overdue 2026-11-08T19:00Z',
    ];
    expect(away('2026-11-02')).toEqual(normal); // yesterday was the last away day
    expect(away(null)).toEqual(normal);
    expect(away(null, { assignee: null })).toEqual(normal);
    expect(
      show({
        occurrence: { due: allDay('2026-11-04') },
        now: at('2026-11-03T10:00:00Z'),
        overdueHorizonDays: 7,
      }),
    ).toEqual(normal);
  });

  it('holds an assignee who is away on the day itself (the last day counts as away)', () => {
    expect(away('2026-11-03')).toEqual([
      'due 2026-11-04T19:00Z',
      'overdue 2026-11-05T19:00Z',
      'overdue 2026-11-08T19:00Z',
    ]);
    expect(away('2026-11-03', { now: at('2026-11-03T23:00:00Z') })).toEqual([
      'due 2026-11-04T19:00Z',
      'overdue 2026-11-05T19:00Z',
      'overdue 2026-11-08T19:00Z',
    ]);
  });

  it('moves a hold that lands in quiet hours to the next slot', () => {
    expect(
      away('2026-11-05', {
        task: { reminderSlot: 'custom_time', reminderCustomTime: '22:00' },
      }),
    ).toEqual([
      // Held to 22:00 on the 6th, which is quiet. The 4 Nov due reminder is held and dropped.
      'overdue 2026-11-07T08:00Z',
      'overdue 2026-11-09T08:00Z', // 22:00 on the 8th, moved to the next morning
    ]);
  });

  it('uses the later of an away hold and a snooze', () => {
    const later = at('2026-11-07T10:00:00Z');
    expect(
      away('2026-11-05', { occurrence: { due: allDay('2026-11-04'), snoozedUntil: later } }),
    ).toEqual(['overdue 2026-11-07T10:00Z', 'overdue 2026-11-08T19:00Z']);
    const earlier = at('2026-11-05T10:00:00Z');
    expect(
      away('2026-11-05', { occurrence: { due: allDay('2026-11-04'), snoozedUntil: earlier } }),
    ).toEqual(['overdue 2026-11-06T19:00Z', 'overdue 2026-11-08T19:00Z']);
  });

  it('numbers a held overdue reminder by the day it is moved to', () => {
    // Standard overdue reminders are on days 1, 4 and 7 after 1 Nov (2, 5 and 8 Nov). Now is
    // day 2; the day 4 reminder is held until day 6 (7 Nov) and keeps its key.
    const planned = planReminders(
      input({
        occurrence: { due: allDay('2026-11-01'), snoozedUntil: at('2026-11-07T12:00:00Z') },
        now: at('2026-11-03T10:00:00Z'),
        overdueHorizonDays: 6,
      }),
    );
    expect(planned.map((r) => [r.key, r.fireAt.toISOString().slice(0, 16), r.overdueDays])).toEqual(
      [
        ['overdue:2026-11-05', '2026-11-07T12:00', 6],
        ['overdue:2026-11-08', '2026-11-08T19:00', 7],
      ],
    );
  });

  it('judges "away today" by the household date, which is ahead of UTC late on a BST evening', () => {
    // 23:30Z on 12 Oct is 00:30 BST on the 13th.
    const lateEvening = (awayUntil: string) =>
      show({
        occurrence: { due: allDay('2026-10-13') },
        assignee: { awayUntil },
        now: at('2026-10-12T23:30:00Z'),
        overdueHorizonDays: 1,
      });
    // Away on the 13th: the due reminder is held until the evening of the 14th.
    expect(lateEvening('2026-10-13')).toEqual(['due 2026-10-14T18:00Z']);
    // The 12th was the last away day: back on the 13th, nothing is held.
    expect(lateEvening('2026-10-12')).toEqual(['due 2026-10-13T18:00Z']);
  });
});

describe('past reminders and the overdue horizon', () => {
  it('drops reminders at or before now, but not one a moment later', () => {
    const decide = (now: string) =>
      show({ task: carInsurance, now: at(now), overdueHorizonDays: 0 }).filter((r) =>
        r.endsWith('2026-10-18T18:00Z'),
      );
    expect(decide('2026-10-18T17:59:59.999Z')).toEqual(['milestone 2026-10-18T18:00Z']);
    expect(decide('2026-10-18T18:00:00Z')).toEqual([]);
    expect(
      show({ task: carInsurance, now: at('2030-01-01T00:00:00Z'), overdueHorizonDays: 0 }),
    ).toEqual([]);
  });

  it('plans overdue reminders only up to the horizon, inclusive', () => {
    const due = { due: allDay('2026-11-01') };
    const now = at('2026-11-01T19:00:00Z');
    expect(show({ occurrence: due, now, overdueHorizonDays: 0 })).toEqual([]);
    expect(show({ occurrence: due, now, overdueHorizonDays: 1 })).toEqual([
      'overdue 2026-11-02T19:00Z',
    ]);
    expect(show({ occurrence: due, now, overdueHorizonDays: 3 })).toEqual([
      'overdue 2026-11-02T19:00Z',
    ]);
    expect(show({ occurrence: due, now, overdueHorizonDays: 4 })).toEqual([
      'overdue 2026-11-02T19:00Z',
      'overdue 2026-11-05T19:00Z',
    ]);
  });

  it('defaults to a 14 day horizon', () => {
    expect(DEFAULT_OVERDUE_HORIZON_DAYS).toBe(14);
    const planned = planReminders(input({ now: at('2026-11-01T19:00:00Z') }));
    // The horizon is 15 Nov 19:00Z, inclusive: 2, 5, 8, 11 and 14 Nov, but not 17 Nov.
    expect(planned.map((r) => r.fireAt.toISOString().slice(5, 10))).toEqual([
      '11-02',
      '11-05',
      '11-08',
      '11-11',
      '11-14',
    ]);
  });

  it.each([
    ['persistent', [1076, 1077, 1078]],
    ['standard', [1078]],
  ] as const)('keeps %s overdue numbering after about three years', (reminderProfile, days) => {
    // 1 Nov 2023 to 12 Oct 2026 is 1076 days. Standard reminders are on days 1, 4, 7, ...
    const planned = planReminders(
      input({
        occurrence: { due: allDay('2023-11-01') },
        task: { reminderProfile },
        now: at('2026-10-12T09:00:00Z'),
        overdueHorizonDays: 3,
      }),
    );
    expect(planned.map((r) => r.overdueDays)).toEqual(days);
    expect(planned.map((r) => r.key)).toEqual(
      days.map((d) => `overdue:${new Date(Date.UTC(2023, 10, 1 + d)).toISOString().slice(0, 10)}`),
    );
  });

  it('numbers overdue days from the due day, however long ago it was', () => {
    const planned = planReminders(
      input({
        occurrence: { due: allDay('2026-01-01') },
        now: at('2026-06-01T09:00:00Z'),
        overdueHorizonDays: 4,
      }),
    );
    expect(planned.map((r) => [r.key, r.overdueDays])).toEqual([
      ['overdue:2026-06-01', 151],
      ['overdue:2026-06-04', 154],
    ]);
  });
});

describe('invalid input', () => {
  const bad = (o: Overrides) => () => planReminders(input(o));

  it.each<[string, Overrides]>([
    ['now', { now: new Date(Number.NaN) }],
    ['a due', { occurrence: { due: allDay('2026-02-30') } }],
    ['a timed due', { occurrence: { due: { allDay: false, at: new Date(Number.NaN) } } }],
    ['snoozedUntil', { occurrence: { snoozedUntil: new Date(Number.NaN) } }],
    ['awayUntil', { assignee: { awayUntil: 'next week' } }],
    ['a negative lead time', { task: { leadTimeDays: -1 } }],
    ['a fractional lead time', { task: { leadTimeDays: 1.5 } }],
    ['a positive remindOffsetDays', { task: { remindOffsetDays: 1 } }],
    ['a fractional remindOffsetDays', { task: { remindOffsetDays: -0.5 } }],
    [
      'a negative milestone offset',
      { task: { milestones: [{ id: 'm', title: 'Late', offsetDaysBeforeDue: -1 }] } },
    ],
    ['a negative overdue horizon', { overdueHorizonDays: -1 }],
    ['a custom time without a time', { task: { reminderSlot: 'custom_time' } }],
    ['a bad custom time', { task: { reminderSlot: 'custom_time', reminderCustomTime: '25:00' } }],
    ['a bad morning slot', { household: { morningSlot: '8am' } }],
    ['a bad evening slot', { household: { eveningSlot: '19:00:60' } }],
    ['a bad quiet hours start', { household: { quietHours: { start: '9:30', end: '07:30' } } }],
    ['a bad quiet hours end', { household: { quietHours: { start: '21:30', end: '' } } }],
    ['a bad time zone', { household: { timezone: 'Mars/Olympus' } }],
  ])('throws for %s, even when nothing would be planned', (_name, overrides) => {
    expect(bad({ ...overrides, occurrence: { status: 'done', ...overrides.occurrence } })).toThrow(
      RecurrenceError,
    );
  });
});
