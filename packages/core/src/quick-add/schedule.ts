import { wallToInstant } from '@tracker/shared';
import { localToday, startOfLocalDay } from '../day.js';
import { rrules } from '../recurrence/builders.js';
import { previewDates } from '../recurrence/expand.js';
import type { WeekdayCode } from '../recurrence/rrule-parse.js';
import type { Due, LocalDate } from '../recurrence/types.js';
import type { RecurrencePattern } from './recurrence-phrase.js';
import type { QuickAddTask } from './types.js';

/** What the text said about when, before it becomes task fields. */
export interface ScheduleRequest {
  /** A named date. */
  date?: LocalDate | undefined;
  /** For a time on its own: the day that time next falls on. */
  impliedDate?: LocalDate | undefined;
  /** `HH:MM`: makes the task timed. */
  time?: string | undefined;
  /** How it repeats, or nothing for a one-off. */
  pattern?: RecurrencePattern | undefined;
}

export type ScheduleFields = Pick<
  QuickAddTask,
  'scheduleKind' | 'allDay' | 'dueDate' | 'dueAt' | 'rrule' | 'intervalAfterCompletionDays'
>;

const WEEKDAY_BY_INDEX: readonly WeekdayCode[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** The weekday of a calendar date (`YYYY-MM-DD`). */
function weekdayOf(date: LocalDate): WeekdayCode {
  return WEEKDAY_BY_INDEX[new Date(`${date}T00:00:00Z`).getUTCDay()] as WeekdayCode;
}

/**
 * An "every N units" rule on the day of `anchor`: weekly on its weekday, monthly on its day of
 * the month, yearly on its date. Built with `rrules`, so the editor can read it back.
 */
export function anchoredRule(
  unit: 'day' | 'week' | 'month' | 'year',
  interval: number,
  anchor: LocalDate,
): string {
  const month = Number(anchor.slice(5, 7));
  const day = Number(anchor.slice(8, 10));
  switch (unit) {
    case 'day':
      return rrules.daily(interval);
    case 'week':
      return rrules.weekly([weekdayOf(anchor)], interval);
    case 'month':
      return rrules.monthlyOnDay(day, interval);
    case 'year':
      return rrules.yearly(month, day, interval);
  }
}

const PLAIN_RULE = /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(?:;INTERVAL=(\d+))?$/;
const YEARLY_DATE_RULE = /^FREQ=YEARLY;BYMONTH=(\d+);BYMONTHDAY=(\d+)$/;
const UNIT_OF_FREQ = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' } as const;

/**
 * A template's rule as it should be stored for a task due on `anchor`. A bare `FREQ=YEARLY` (or
 * monthly, weekly, daily, with an optional interval) carries no date of its own, so it becomes
 * the rule for that date; a fixed date (31 Jan) is only rewritten with `rrules`; anything more
 * specific (the last Sunday of March) is kept.
 */
export function anchorTemplateRule(rrule: string, anchor: LocalDate): string {
  // A fixed calendar date (31 Jan) is rewritten with the builder so the editor can read it back.
  const yearly = YEARLY_DATE_RULE.exec(rrule);
  if (yearly) return rrules.yearly(Number(yearly[1]), Number(yearly[2]));
  const plain = PLAIN_RULE.exec(rrule);
  if (!plain) return rrule;
  return anchoredRule(
    UNIT_OF_FREQ[plain[1] as keyof typeof UNIT_OF_FREQ],
    Number(plain[2] ?? 1),
    anchor,
  );
}

function dueFields(due: Due): Pick<ScheduleFields, 'allDay' | 'dueDate' | 'dueAt'> {
  return due.allDay
    ? { allDay: true, dueDate: due.date }
    : { allDay: false, dueAt: due.at.toISOString() };
}

/**
 * The scheduling fields for a request, in the household's zone.
 *
 * - No pattern: a one-off on the named date (timed if there is a time), or undated.
 * - A rule: a `fixed` task whose first due is the first date matching the rule on or after the
 *   named date, or on or after now when no date was named ("every Tuesday" typed on a Saturday
 *   starts on Tuesday), found with the recurrence engine.
 * - After completion: due on the named date, or today.
 */
export function buildSchedule(
  request: ScheduleRequest,
  now: Date,
  timezone: string,
): ScheduleFields {
  const { pattern, date, time } = request;
  const anchor = date ?? (pattern ? localToday(now, timezone) : request.impliedDate);
  if (anchor === undefined) return { scheduleKind: 'once', allDay: true };
  const start: Due =
    time === undefined
      ? { allDay: true, date: anchor }
      : { allDay: false, at: wallToInstant(anchor, time, timezone) as Date };

  if (!pattern) return { scheduleKind: 'once', ...dueFields(start) };
  if (pattern.kind === 'after_completion') {
    return {
      scheduleKind: 'after_completion',
      intervalAfterCompletionDays: pattern.days,
      ...dueFields(start),
    };
  }

  const rrule =
    pattern.kind === 'rrule' ? pattern.rrule : anchoredRule(pattern.unit, pattern.interval, anchor);
  const from =
    date === undefined ? now : start.allDay ? startOfLocalDay(start.date, timezone) : start.at;
  const [first] = previewDates({ kind: 'fixed', rrule, start }, from, 1, { timezone });
  return { scheduleKind: 'fixed', rrule, ...dueFields(first ?? start) };
}
