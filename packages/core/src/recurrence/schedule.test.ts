import { describe, expect, it } from 'vitest';
import { RecurrenceError } from './errors.js';
import { scheduleFromTask, validateSchedule, type TaskScheduleFields } from './schedule.js';
import { allDay, at } from './test-util.js';

const row = (overrides: Partial<TaskScheduleFields>): TaskScheduleFields => ({
  scheduleKind: 'once',
  allDay: true,
  dueDate: null,
  dueAt: null,
  rrule: null,
  intervalAfterCompletionDays: null,
  ...overrides,
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof RecurrenceError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('scheduleFromTask', () => {
  it('maps once tasks: undated, all-day and timed', () => {
    expect(scheduleFromTask(row({}))).toEqual({ kind: 'once', due: null });
    expect(scheduleFromTask(row({ dueDate: '2026-11-01' }))).toEqual({
      kind: 'once',
      due: { allDay: true, date: '2026-11-01' },
    });
    const dueAt = at('2026-11-01T09:00:00Z');
    expect(scheduleFromTask(row({ allDay: false, dueAt }))).toEqual({
      kind: 'once',
      due: { allDay: false, at: dueAt },
    });
  });

  it('maps fixed and after_completion tasks', () => {
    expect(
      scheduleFromTask(row({ scheduleKind: 'fixed', dueDate: '2026-11-01', rrule: 'FREQ=YEARLY' })),
    ).toEqual({ kind: 'fixed', rrule: 'FREQ=YEARLY', start: allDay('2026-11-01') });
    const dueAt = at('2026-11-01T09:00:00Z');
    expect(
      scheduleFromTask(
        row({
          scheduleKind: 'after_completion',
          allDay: false,
          dueAt,
          intervalAfterCompletionDays: 42,
        }),
      ),
    ).toEqual({ kind: 'after_completion', intervalDays: 42, start: { allDay: false, at: dueAt } });
  });

  it.each([
    [
      'timed task flagged all-day',
      row({ allDay: true, dueAt: at('2026-11-01T09:00:00Z') }),
      'invalid_schedule',
    ],
    [
      'timed task with a dueDate',
      row({ allDay: false, dueAt: at('2026-11-01T09:00:00Z'), dueDate: '2026-11-01' }),
      'invalid_schedule',
    ],
    ['not all-day but no dueAt', row({ allDay: false }), 'invalid_schedule'],
    ['impossible dueDate', row({ dueDate: '2026-02-30' }), 'invalid_date'],
    ['invalid dueAt', row({ allDay: false, dueAt: new Date('x') }), 'invalid_date'],
    [
      'fixed without a first due',
      row({ scheduleKind: 'fixed', rrule: 'FREQ=DAILY' }),
      'invalid_schedule',
    ],
    [
      'after_completion without a first due',
      row({ scheduleKind: 'after_completion', intervalAfterCompletionDays: 7 }),
      'invalid_schedule',
    ],
    [
      'fixed without an rrule',
      row({ scheduleKind: 'fixed', dueDate: '2026-11-01' }),
      'invalid_schedule',
    ],
    [
      'fixed with a bad rrule',
      row({ scheduleKind: 'fixed', dueDate: '2026-11-01', rrule: 'FREQ=NEVER' }),
      'invalid_rrule',
    ],
    [
      'fixed with an unsupported rrule',
      row({ scheduleKind: 'fixed', dueDate: '2026-11-01', rrule: 'FREQ=HOURLY' }),
      'unsupported_rrule',
    ],
    [
      'after_completion without an interval',
      row({ scheduleKind: 'after_completion', dueDate: '2026-11-01' }),
      'invalid_schedule',
    ],
    [
      'after_completion with interval 0',
      row({
        scheduleKind: 'after_completion',
        dueDate: '2026-11-01',
        intervalAfterCompletionDays: 0,
      }),
      'invalid_argument',
    ],
  ])('rejects %s', (_label, task, code) => {
    expect(codeOf(() => scheduleFromTask(task))).toBe(code);
  });
});

describe('validateSchedule', () => {
  it('accepts valid schedules', () => {
    expect(codeOf(() => validateSchedule({ kind: 'once', due: null }))).toBe('no error');
    expect(codeOf(() => validateSchedule({ kind: 'once', due: allDay('2026-01-01') }))).toBe(
      'no error',
    );
  });

  it('rejects an invalid one-off due', () => {
    expect(codeOf(() => validateSchedule({ kind: 'once', due: allDay('2026-01-32') }))).toBe(
      'invalid_date',
    );
  });
});
