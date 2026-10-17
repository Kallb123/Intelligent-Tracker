import { describe, expect, it } from 'vitest';
import {
  MAX_TITLE_LENGTH,
  occurrenceListQuerySchema,
  snoozeBodySchema,
  taskBodySchema,
  taskFieldsIssues,
  taskListQuerySchema,
  taskPatchSchema,
  type TaskCrossFieldInput,
} from './tasks.js';

const weekly = {
  title: 'Bins',
  scheduleKind: 'fixed',
  rrule: 'FREQ=WEEKLY;BYDAY=MO',
  dueDate: '2026-07-06',
} as const;

/** The first issue's path and message, or null when the body is valid. */
function firstIssue(body: unknown): { path: string; message: string } | null {
  const result = taskBodySchema.safeParse(body);
  if (result.success) return null;
  const [issue] = result.error.issues;
  return { path: issue?.path.join('.') ?? '', message: issue?.message ?? '' };
}

describe('taskBodySchema', () => {
  it('applies defaults and trims text', () => {
    const parsed = taskBodySchema.parse({ ...weekly, title: '  Bins  ', category: ' Home ' });
    expect(parsed).toEqual({
      title: 'Bins',
      workingDaysOnly: false,
      remindOffsetDays: 0,
      notes: '',
      category: 'Home',
      tags: [],
      priority: 0,
      reminderSlot: 'evening',
      scheduleKind: 'fixed',
      allDay: true,
      dueDate: '2026-07-06',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      assignmentMode: 'fixed',
      assigneeIds: [],
      milestones: [],
    });
  });

  it('accepts a title of exactly MAX_TITLE_LENGTH and no more', () => {
    const body = { scheduleKind: 'once' };
    expect(taskBodySchema.safeParse({ ...body, title: 'a'.repeat(MAX_TITLE_LENGTH) }).success).toBe(
      true,
    );
    expect(
      taskBodySchema.safeParse({ ...body, title: 'a'.repeat(MAX_TITLE_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it('accepts an undated one-off task', () => {
    expect(taskBodySchema.safeParse({ title: 'Sort loft', scheduleKind: 'once' }).success).toBe(
      true,
    );
  });

  it('accepts a timed task and an after_completion task', () => {
    expect(
      taskBodySchema.safeParse({
        title: 'Call',
        scheduleKind: 'once',
        allDay: false,
        dueAt: '2026-07-06T09:30:00+01:00',
      }).success,
    ).toBe(true);
    expect(
      taskBodySchema.safeParse({
        title: 'Filter',
        scheduleKind: 'after_completion',
        intervalAfterCompletionDays: 30,
        dueDate: '2026-07-06',
      }).success,
    ).toBe(true);
  });

  it('accepts nulls for nullable fields, so a stored task can be sent back', () => {
    const result = taskBodySchema.safeParse({
      title: 'Sort loft',
      scheduleKind: 'once',
      category: null,
      reminderCustomTime: null,
      effortMinutes: null,
      dueDate: null,
      dueAt: null,
      rrule: null,
      intervalAfterCompletionDays: null,
      leadTimeDays: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects both dueDate and dueAt, naming the field that does not fit', () => {
    expect(firstIssue({ ...weekly, dueAt: '2026-07-06T09:00:00Z' })).toMatchObject({
      path: 'dueAt',
    });
    expect(firstIssue({ ...weekly, allDay: false, dueAt: '2026-07-06T09:00:00Z' })).toMatchObject({
      path: 'dueDate',
    });
  });

  it('needs dueAt for a timed task', () => {
    expect(firstIssue({ title: 'x', scheduleKind: 'once', allDay: false })).toMatchObject({
      path: 'dueAt',
    });
  });

  it('needs a first due for fixed and after_completion tasks', () => {
    expect(firstIssue({ title: 'x', scheduleKind: 'fixed', rrule: 'FREQ=DAILY' })).toMatchObject({
      path: 'dueDate',
    });
    expect(
      firstIssue({ title: 'x', scheduleKind: 'after_completion', intervalAfterCompletionDays: 3 }),
    ).toMatchObject({ path: 'dueDate' });
  });

  it('requires rrule iff fixed', () => {
    expect(firstIssue({ ...weekly, rrule: undefined })).toMatchObject({ path: 'rrule' });
    expect(firstIssue({ title: 'x', scheduleKind: 'once', rrule: 'FREQ=DAILY' })).toMatchObject({
      path: 'rrule',
      message: 'rrule is only for fixed tasks',
    });
  });

  it('requires intervalAfterCompletionDays iff after_completion', () => {
    expect(
      firstIssue({ title: 'x', scheduleKind: 'after_completion', dueDate: '2026-07-06' }),
    ).toMatchObject({ path: 'intervalAfterCompletionDays' });
    expect(firstIssue({ ...weekly, intervalAfterCompletionDays: 7 })).toMatchObject({
      path: 'intervalAfterCompletionDays',
    });
  });

  it('requires reminderCustomTime for the custom_time slot, as HH:MM', () => {
    expect(firstIssue({ ...weekly, reminderSlot: 'custom_time' })).toMatchObject({
      path: 'reminderCustomTime',
    });
    expect(
      taskBodySchema.safeParse({
        ...weekly,
        reminderSlot: 'custom_time',
        reminderCustomTime: '07:15',
      }).success,
    ).toBe(true);
    for (const bad of ['7:15', '24:00', '07:60', '07:15:00', 'noon']) {
      expect(
        taskBodySchema.safeParse({
          ...weekly,
          reminderSlot: 'custom_time',
          reminderCustomTime: bad,
        }).success,
        bad,
      ).toBe(false);
    }
  });

  it('rejects impossible dates and instants without an offset', () => {
    expect(firstIssue({ ...weekly, dueDate: '2026-02-30' })).toMatchObject({ path: 'dueDate' });
    expect(firstIssue({ ...weekly, dueDate: '06/07/2026' })).toMatchObject({ path: 'dueDate' });
    expect(
      firstIssue({ title: 'x', scheduleKind: 'once', allDay: false, dueAt: '2026-07-06T09:00:00' }),
    ).toMatchObject({ path: 'dueAt' });
  });

  it('enforces field bounds', () => {
    const bad: Record<string, unknown>[] = [
      { title: '   ' },
      { title: 'x'.repeat(201) },
      { notes: 'x'.repeat(10_001) },
      { category: '' },
      { category: 'x'.repeat(61) },
      { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      { tags: [' '] },
      { tags: ['x'.repeat(41)] },
      { priority: 4 },
      { priority: -1 },
      { priority: 1.5 },
      { effortMinutes: 0 },
      { effortMinutes: 1441 },
      { rrule: 'x'.repeat(501) },
      { leadTimeDays: -1 },
      { leadTimeDays: 3651 },
      { reminderProfile: 'loud' },
      { assignmentMode: 'random' },
      { milestones: [{ title: '', offsetDaysBeforeDue: 1 }] },
      { milestones: [{ title: 'a', offsetDaysBeforeDue: -1 }] },
      { milestones: Array.from({ length: 21 }, () => ({ title: 'a', offsetDaysBeforeDue: 1 })) },
    ];
    for (const extra of bad) {
      expect(taskBodySchema.safeParse({ ...weekly, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
    expect(
      taskBodySchema.safeParse({
        ...weekly,
        intervalAfterCompletionDays: 0,
        scheduleKind: 'after_completion',
        rrule: undefined,
      }).success,
    ).toBe(false);
  });

  it('keeps ordered, unique, bounded assigneeIds', () => {
    const a = '0b9c1a52-6f4b-4c0a-8d1a-1f6b0c7d9e11';
    const b = '5d7e6a1c-3c2b-4e6f-9a55-2b1c3d4e5f60';
    expect(taskBodySchema.parse({ ...weekly, assigneeIds: [b, a] }).assigneeIds).toEqual([b, a]);
    expect(firstIssue({ ...weekly, assigneeIds: [a, a] })).toMatchObject({
      path: 'assigneeIds',
      message: 'assigneeIds must be unique',
    });
    expect(firstIssue({ ...weekly, assigneeIds: ['nope'] })).toMatchObject({
      path: 'assigneeIds.0',
    });
    const many = Array.from(
      { length: 21 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(firstIssue({ ...weekly, assigneeIds: many })).toMatchObject({ path: 'assigneeIds' });
  });
});

describe('taskFieldsIssues', () => {
  const base: TaskCrossFieldInput = {
    scheduleKind: 'once',
    allDay: true,
    reminderSlot: 'evening',
  };

  it('is empty for a valid undated task and treats null like undefined', () => {
    expect(taskFieldsIssues(base)).toEqual([]);
    expect(
      taskFieldsIssues({
        ...base,
        dueDate: null,
        dueAt: null,
        rrule: null,
        reminderCustomTime: null,
      }),
    ).toEqual([]);
  });

  it('reports every problem at once, each with its own path', () => {
    const issues = taskFieldsIssues({
      ...base,
      scheduleKind: 'fixed',
      allDay: false,
      dueDate: '2026-07-06',
      reminderSlot: 'custom_time',
    });
    expect(issues.map((i) => i.path[0])).toEqual([
      'dueDate',
      'dueAt',
      'rrule',
      'reminderCustomTime',
    ]);
  });
});

describe('taskPatchSchema', () => {
  it('accepts an empty patch and does not apply body defaults', () => {
    expect(taskPatchSchema.parse({})).toEqual({});
  });

  it('accepts any subset, nulls to clear, archived, and whole-list replacements', () => {
    const patch = taskPatchSchema.parse({
      title: ' New ',
      dueDate: null,
      archived: true,
      milestones: [],
      assigneeIds: [],
    });
    expect(patch).toEqual({
      title: 'New',
      dueDate: null,
      archived: true,
      milestones: [],
      assigneeIds: [],
    });
  });

  it('keeps the field rules', () => {
    expect(taskPatchSchema.safeParse({ priority: 9 }).success).toBe(false);
    expect(taskPatchSchema.safeParse({ archived: 'yes' }).success).toBe(false);
    expect(taskPatchSchema.safeParse({ assigneeIds: ['x'] }).success).toBe(false);
  });

  it('can be merged onto a stored task and re-validated with the body schema', () => {
    const stored = { ...weekly, allDay: true, reminderSlot: 'evening' } as const;
    const merged = { ...stored, ...taskPatchSchema.parse({ scheduleKind: 'once' }) };
    // The stored rrule is still there, so the merged task contradicts itself.
    expect(firstIssue(merged)).toMatchObject({ path: 'rrule' });
    expect(firstIssue({ ...merged, rrule: null })).toBeNull();
  });
});

describe('query and snooze schemas', () => {
  it('defaults the occurrence list query and coerces query strings', () => {
    expect(occurrenceListQuerySchema.parse({})).toEqual({ view: 'today', days: 30, limit: 200 });
    expect(
      occurrenceListQuerySchema.parse({ view: 'upcoming', days: '7', limit: '10' }),
    ).toMatchObject({ view: 'upcoming', days: 7, limit: 10 });
  });

  it('bounds days, limit, view and ids', () => {
    for (const q of [
      { view: 'later' },
      { days: '0' },
      { days: '367' },
      { days: '1.5' },
      { limit: '501' },
      { limit: '0' },
      { memberId: 'x' },
      { taskId: 'x' },
    ]) {
      expect(occurrenceListQuerySchema.safeParse(q).success, JSON.stringify(q)).toBe(false);
    }
  });

  it('parses the archived flag of the task list', () => {
    expect(taskListQuerySchema.parse({})).toEqual({ archived: false });
    expect(taskListQuerySchema.parse({ archived: 'true' })).toEqual({ archived: true });
    expect(taskListQuerySchema.safeParse({ archived: 'maybe' }).success).toBe(false);
  });

  it('takes exactly one of until and days when snoozing', () => {
    expect(snoozeBodySchema.safeParse({ days: 3 }).success).toBe(true);
    expect(snoozeBodySchema.safeParse({ until: '2026-07-06T09:00:00Z' }).success).toBe(true);
    expect(snoozeBodySchema.safeParse({}).success).toBe(false);
    expect(snoozeBodySchema.safeParse({ days: 3, until: '2026-07-06T09:00:00Z' }).success).toBe(
      false,
    );
    expect(snoozeBodySchema.safeParse({ days: 0 }).success).toBe(false);
    expect(snoozeBodySchema.safeParse({ days: 366 }).success).toBe(false);
    expect(snoozeBodySchema.safeParse({ until: 'tomorrow' }).success).toBe(false);
  });
});
