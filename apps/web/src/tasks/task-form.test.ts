import { defaultRecurrence } from '@tracker/core';
import type { TaskDto } from '@tracker/shared';
import { taskBodySchema } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import {
  formatDue,
  formFromTask,
  milestoneProblem,
  newTaskForm,
  parseTags,
  previewSchedule,
  scheduleFields,
  taskBody,
  type TaskForm,
} from './task-form.js';

const TZ = 'Europe/London';
const ME = '11111111-1111-4111-8111-111111111111';
const SAM = '44444444-4444-4444-8444-444444444444';

function form(overrides: Partial<TaskForm> = {}): TaskForm {
  return { ...newTaskForm('2026-10-12', ME), title: 'Bins', ...overrides };
}

const weekly = (days: ('MO' | 'TH')[], interval = 1) => ({
  ...defaultRecurrence('weekly'),
  weekdays: days,
  interval,
});

describe('newTaskForm', () => {
  it('starts as an all-day one-off due today, in the evening, for whoever is creating it', () => {
    expect(newTaskForm('2026-10-12', ME)).toMatchObject({
      allDay: true,
      dueDate: '2026-10-12',
      recurrence: { kind: 'once' },
      reminderSlot: 'evening',
      assignmentMode: 'fixed',
      fixedAssignee: ME,
    });
  });
});

describe('parseTags', () => {
  it('trims, drops blanks and repeats', () => {
    expect(parseTags(' garden , diy,, garden,')).toEqual(['garden', 'diy']);
    expect(parseTags('')).toEqual([]);
  });
});

describe('taskBody', () => {
  it('builds the body the api expects for a weekly task', () => {
    const body = taskBody(form({ recurrence: weekly(['MO']) }), TZ);

    expect(body).toEqual({
      title: 'Bins',
      notes: '',
      category: null,
      tags: [],
      priority: 0,
      effortMinutes: null,
      reminderSlot: 'evening',
      reminderCustomTime: null,
      scheduleKind: 'fixed',
      allDay: true,
      dueDate: '2026-10-12',
      dueAt: null,
      rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
      intervalAfterCompletionDays: null,
      workingDaysOnly: false,
      remindOffsetDays: 0,
      leadTimeDays: null,
      assignmentMode: 'fixed',
      assigneeIds: [ME],
      milestones: [],
    });
    expect(taskBodySchema.safeParse(body).success).toBe(true);
  });

  it('converts a timed due from household time to an instant', () => {
    const body = taskBody(form({ allDay: false, dueDate: '2026-07-15', dueTime: '14:30' }), TZ);

    expect(body).toMatchObject({ allDay: false, dueDate: null, dueAt: '2026-07-15T13:30:00.000Z' });
    expect(taskBodySchema.safeParse(body).success).toBe(true);
  });

  it('carries the optional fields', () => {
    const body = taskBody(
      form({
        title: '  Descale kettle ',
        category: ' Home ',
        tags: 'kitchen, descale',
        priority: 2,
        effortMinutes: 20,
        recurrence: { ...defaultRecurrence('after_completion'), afterDays: 42 },
        workingDaysOnly: false,
        remindOffsetDays: 0,
        leadTimeDays: 3,
        milestones: [
          { title: ' Buy descaler ', days: 5 },
          { title: '', days: null },
        ],
        reminderProfile: 'gentle',
        reminderSlot: 'custom_time',
        reminderCustomTime: '07:45',
        assignmentMode: 'rotation',
        rotation: [SAM, ME],
      }),
      TZ,
    );

    expect(body).toMatchObject({
      title: 'Descale kettle',
      category: 'Home',
      tags: ['kitchen', 'descale'],
      priority: 2,
      effortMinutes: 20,
      scheduleKind: 'after_completion',
      rrule: null,
      intervalAfterCompletionDays: 42,
      workingDaysOnly: false,
      remindOffsetDays: 0,
      leadTimeDays: 3,
      milestones: [{ title: 'Buy descaler', offsetDaysBeforeDue: 5 }],
      reminderProfile: 'gentle',
      reminderSlot: 'custom_time',
      reminderCustomTime: '07:45',
      assignmentMode: 'rotation',
      assigneeIds: [SAM, ME],
    });
    expect(taskBodySchema.safeParse(body).success).toBe(true);
  });

  it('omits the reminder profile for the household default, and assignees for "anyone"', () => {
    const body = taskBody(form({ assignmentMode: 'any', fixedAssignee: ME }), TZ);

    expect(body).not.toHaveProperty('reminderProfile');
    expect(body.assigneeIds).toEqual([]);
    expect(taskBody(form({ fixedAssignee: '' }), TZ).assigneeIds).toEqual([]);
  });

  it('throws a readable error for an unfinished repeat', () => {
    expect(() => taskBody(form({ recurrence: weekly([]) }), TZ)).toThrow(
      'Pick at least one weekday',
    );
  });

  it('leaves a missing due date to the shared validation', () => {
    const body = taskBody(form({ dueDate: '', recurrence: weekly(['MO']) }), TZ);
    const result = taskBodySchema.safeParse(body);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0]).toBe('dueDate');
    // An undated one-off is fine.
    expect(taskBodySchema.safeParse(taskBody(form({ dueDate: '' }), TZ)).success).toBe(true);
  });
});

describe('milestoneProblem', () => {
  it('accepts complete and completely empty rows, rejects half-filled ones', () => {
    expect(milestoneProblem(form())).toBeUndefined();
    expect(
      milestoneProblem(
        form({
          milestones: [
            { title: 'Pay', days: 7 },
            { title: '', days: null },
          ],
        }),
      ),
    ).toBeUndefined();
    for (const bad of [
      { title: 'Pay', days: null },
      { title: '', days: 7 },
      { title: 'Pay', days: -1 },
      { title: 'Pay', days: 1.5 },
    ]) {
      expect(milestoneProblem(form({ milestones: [bad] }))).toContain('Each milestone');
    }
  });
});

describe('formFromTask', () => {
  const task: TaskDto = {
    id: '55555555-5555-4555-8555-555555555555',
    title: 'Bins',
    notes: 'Green one',
    category: 'Home',
    tags: ['weekly', 'outside'],
    priority: 1,
    reminderSlot: 'morning',
    reminderCustomTime: null,
    effortMinutes: 10,
    scheduleKind: 'fixed',
    allDay: true,
    dueDate: '2026-10-12',
    dueAt: null,
    rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH',
    intervalAfterCompletionDays: null,
    workingDaysOnly: false,
    remindOffsetDays: 0,
    leadTimeDays: 1,
    reminderProfile: 'standard',
    assignmentMode: 'rotation',
    assigneeIds: [SAM, ME],
    nextAssigneeId: SAM,
    nextDue: null,
    milestones: [
      { id: '66666666-6666-4666-8666-666666666666', title: 'Put out', offsetDaysBeforeDue: 0 },
    ],
    archived: false,
    archivedAt: null,
    createdBy: ME,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
  };

  it('reads a stored task, and its RRULE, back into the form', () => {
    const f = formFromTask(task, TZ);

    expect(f).toMatchObject({
      title: 'Bins',
      tags: 'weekly, outside',
      dueDate: '2026-10-12',
      recurrence: { kind: 'weekly', interval: 2, weekdays: ['MO', 'TH'] },
      milestones: [{ title: 'Put out', days: 0 }],
      reminderProfile: 'standard',
      assignmentMode: 'rotation',
      rotation: [SAM, ME],
      fixedAssignee: '',
    });
    // And saving it unchanged sends the same schedule.
    const body = taskBody(f, TZ);
    expect(body).toMatchObject({
      rrule: task.rrule,
      dueDate: task.dueDate,
      assigneeIds: [SAM, ME],
    });
  });

  it('puts a timed due on the household clock', () => {
    const f = formFromTask(
      { ...task, allDay: false, dueDate: null, dueAt: '2026-07-15T13:30:00.000Z' },
      TZ,
    );
    expect(f).toMatchObject({ allDay: false, dueDate: '2026-07-15', dueTime: '14:30' });
  });

  it('falls back to a custom rule and keeps a single fixed assignee', () => {
    const f = formFromTask(
      { ...task, rrule: 'FREQ=DAILY;COUNT=3', assignmentMode: 'fixed', assigneeIds: [SAM] },
      TZ,
    );
    expect(f.recurrence).toMatchObject({ kind: 'custom', customRrule: 'FREQ=DAILY;COUNT=3' });
    expect(f).toMatchObject({ fixedAssignee: SAM, rotation: [] });
  });
});

describe('scheduleFields', () => {
  it('is what core reads a task from', () => {
    expect(scheduleFields(form(), TZ)).toEqual({
      scheduleKind: 'once',
      rrule: null,
      intervalAfterCompletionDays: null,
      allDay: true,
      dueDate: '2026-10-12',
      dueAt: null,
    });
  });
});

describe('previewSchedule', () => {
  // Monday 12 Oct 2026 is the form's due date; "now" is the day before.
  const from = new Date('2026-10-11T12:00:00Z');
  const dates = (f: TaskForm) => {
    const result = previewSchedule(f, TZ, from);
    return 'dues' in result ? result.dues.map((d) => formatDue(d, TZ)) : result.error;
  };

  it('lists the next five dates of a weekly task', () => {
    expect(dates(form({ recurrence: weekly(['MO']) }))).toEqual([
      'Mon 12 Oct 2026',
      'Mon 19 Oct 2026',
      'Mon 26 Oct 2026',
      'Mon 2 Nov 2026',
      'Mon 9 Nov 2026',
    ]);
  });

  it('skips to the first day that matches the rule', () => {
    // Due Mon 12 Oct, but only Thursdays: the first date is Thursday the 15th.
    expect(dates(form({ recurrence: weekly(['TH']) }))?.[0]).toBe('Thu 15 Oct 2026');
  });

  it('shows the time of a timed task in household time', () => {
    const f = form({
      allDay: false,
      dueDate: '2026-10-12',
      dueTime: '09:00',
      recurrence: { ...defaultRecurrence('daily') },
    });
    expect(dates(f)?.slice(0, 2)).toEqual(['Mon 12 Oct 2026 at 09:00', 'Tue 13 Oct 2026 at 09:00']);
  });

  it('shows just the first due for a one-off and for after-completion tasks', () => {
    expect(dates(form())).toEqual(['Mon 12 Oct 2026']);
    const after = previewSchedule(
      form({ recurrence: { ...defaultRecurrence('after_completion'), afterDays: 42 } }),
      TZ,
      from,
    );
    expect(after).toMatchObject({ note: 'Later dates are set when each one is completed.' });
    expect('dues' in after && after.dues).toHaveLength(1);
  });

  it('has nothing to show for a one-off that is already past', () => {
    expect(previewSchedule(form({ dueDate: '2026-01-01' }), TZ, from)).toEqual({ dues: [] });
  });

  it('explains an undated one-off', () => {
    expect(previewSchedule(form({ dueDate: '' }), TZ, from)).toMatchObject({
      dues: [],
      note: expect.stringContaining('always on Today'),
    });
  });

  it('turns every problem into a friendly message', () => {
    expect(dates(form({ recurrence: weekly([]) }))).toBe('Pick at least one weekday');
    expect(dates(form({ dueDate: '', recurrence: weekly(['MO']) }))).toBe(
      'Choose a due date to see the next dates.',
    );
    expect(dates(form({ allDay: false, dueDate: '2026-10-12', dueTime: '' }))).toBe(
      'Choose a due date and time to see the next dates.',
    );
    expect(
      dates(form({ recurrence: { ...defaultRecurrence('custom'), customRrule: 'FREQ=NEVER' } })),
    ).toContain('That repeat rule cannot be used');
    expect(
      dates(form({ recurrence: { ...defaultRecurrence('custom'), customRrule: 'FREQ=HOURLY' } })),
    ).toContain('That repeat rule cannot be used');
  });
});
