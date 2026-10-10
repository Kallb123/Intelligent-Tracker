import { assertValidDue, parseLocalDate } from './calendar.js';
import { assertInteger, RecurrenceError } from './errors.js';
import { parseRRule } from './rrule-parse.js';
import type { Due, Schedule } from './types.js';

/** Upper bound for `after_completion` intervals (ten years of days). */
export const MAX_INTERVAL_DAYS = 3650;

/** The scheduling columns of a `task` row, as a structural type so core never imports the DB. */
export interface TaskScheduleFields {
  scheduleKind: 'once' | 'fixed' | 'after_completion';
  allDay: boolean;
  /** `YYYY-MM-DD`, for all-day tasks. */
  dueDate: string | null;
  /** UTC instant, for timed tasks. */
  dueAt: Date | null;
  rrule: string | null;
  intervalAfterCompletionDays: number | null;
}

/** Throws `RecurrenceError` unless every date, RRULE and interval in the schedule is usable. */
export function validateSchedule(schedule: Schedule): void {
  switch (schedule.kind) {
    case 'once':
      if (schedule.due !== null) assertValidDue(schedule.due);
      return;
    case 'fixed':
      assertValidDue(schedule.start);
      parseRRule(schedule.rrule);
      return;
    case 'after_completion':
      assertValidDue(schedule.start);
      assertInteger(schedule.intervalDays, 1, MAX_INTERVAL_DAYS, 'intervalDays');
      return;
  }
}

function dueOfTask(task: TaskScheduleFields): Due | null {
  if (task.dueAt !== null) {
    if (task.allDay || task.dueDate !== null) {
      throw new RecurrenceError('invalid_schedule', 'A timed task has dueAt but not dueDate');
    }
    return { allDay: false, at: task.dueAt };
  }
  if (!task.allDay) {
    throw new RecurrenceError('invalid_schedule', 'A task with allDay = false needs dueAt');
  }
  if (task.dueDate === null) return null;
  parseLocalDate(task.dueDate);
  return { allDay: true, date: task.dueDate };
}

/**
 * Builds a `Schedule` from the scheduling columns of a task row. Throws `RecurrenceError`
 * (`invalid_schedule`, `invalid_date`, `invalid_rrule` ...) for rows that contradict themselves,
 * so a corrupt task fails loudly instead of producing wrong dates.
 */
export function scheduleFromTask(task: TaskScheduleFields): Schedule {
  const due = dueOfTask(task);
  let schedule: Schedule;
  if (task.scheduleKind === 'once') {
    schedule = { kind: 'once', due };
  } else if (due === null) {
    throw new RecurrenceError(
      'invalid_schedule',
      `A ${task.scheduleKind} task needs a first due date`,
    );
  } else if (task.scheduleKind === 'fixed') {
    if (task.rrule === null) {
      throw new RecurrenceError('invalid_schedule', 'A fixed task needs an rrule');
    }
    schedule = { kind: 'fixed', rrule: task.rrule, start: due };
  } else {
    if (task.intervalAfterCompletionDays === null) {
      throw new RecurrenceError(
        'invalid_schedule',
        'An after_completion task needs intervalAfterCompletionDays',
      );
    }
    schedule = {
      kind: 'after_completion',
      intervalDays: task.intervalAfterCompletionDays,
      start: due,
    };
  }
  validateSchedule(schedule);
  return schedule;
}
