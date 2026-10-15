import { formatCalendarDate, instantToWall, type TaskDto } from '@tracker/shared';
import {
  MONTH_NAMES,
  parseRecurrence,
  WEEKDAY_NAMES,
  type RecurrenceState,
} from './recurrence-form.js';

/** 1st, 2nd, 3rd, 4th, 11th, 21st ... */
export function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** "Monday", "Monday and Thursday", "Monday, Wednesday and Friday". */
function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "Every week", "Every 2 weeks": the cadence of a pattern that repeats every `n` units. */
function every(n: number | null, unit: string): string {
  return n === null || n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
}

/** The repeat pattern in words, such as "Every 2 weeks on Monday and Thursday". */
export function describeRecurrence(state: RecurrenceState): string {
  const onDay = state.lastDay ? 'the last day' : `the ${ordinal(state.monthDay ?? 1)}`;
  switch (state.kind) {
    case 'once':
      return 'Once';
    case 'daily':
      return every(state.interval, 'day');
    case 'weekly':
      return `${every(state.interval, 'week')} on ${list(state.weekdays.map((d) => WEEKDAY_NAMES[d]))}`;
    case 'monthly':
      if (state.monthlyMode === 'day') return `${every(state.interval, 'month')} on ${onDay}`;
      return `${every(state.interval, 'month')} on the ${
        state.nth === -1 ? 'last' : ordinal(state.nth)
      } ${WEEKDAY_NAMES[state.nthWeekday]}`;
    case 'yearly': {
      const month = MONTH_NAMES[state.month - 1] ?? '';
      const date = state.lastDay ? `the last day of ${month}` : `${state.monthDay} ${month}`;
      return `${every(state.interval, 'year')} on ${date}`;
    }
    case 'custom':
      return `Custom schedule (${state.customRrule})`;
    case 'after_completion': {
      const days = state.afterDays ?? 1;
      const cadence = days % 7 === 0 ? every(days / 7, 'week') : every(days, 'day');
      return `${cadence} after it's done`;
    }
  }
}

type ScheduleTask = Pick<
  TaskDto,
  'scheduleKind' | 'rrule' | 'intervalAfterCompletionDays' | 'allDay' | 'dueDate' | 'dueAt'
>;

/**
 * A task's schedule in words: "Every week on Monday", "Every 6 weeks after it's done",
 * "Once, 1 Nov 2026". `timeZone` is the household's, for the time of a timed one-off.
 */
export function describeSchedule(task: ScheduleTask, timeZone: string): string {
  if (task.scheduleKind !== 'once') return describeRecurrence(parseRecurrence(task));
  if (task.allDay)
    return task.dueDate ? `Once, ${formatCalendarDate(task.dueDate)}` : 'Once, no date';
  if (!task.dueAt) return 'Once, no date';
  // The date of a timed due is the household's local date, not the browser's.
  const { date, time } = instantToWall(task.dueAt, timeZone);
  return `Once, ${formatCalendarDate(date)} at ${time}`;
}
