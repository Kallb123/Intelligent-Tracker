import { RecurrenceError, rrules, WEEKDAY_CODES, type WeekdayCode } from '@tracker/core';

/**
 * The state behind the editor's recurrence builder, and the two-way mapping between it and what a
 * task stores (`scheduleKind`, `rrule`, `intervalAfterCompletionDays`). Pure, so it is unit-tested
 * without a DOM. The builder only writes RRULEs that core's `rrules` builders produce, which is
 * what lets `parseRecurrence` turn a stored rule back into the builder; anything else is "custom".
 */

export const REPEAT_KINDS = [
  'once',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'custom',
  'after_completion',
] as const;
export type RepeatKind = (typeof REPEAT_KINDS)[number];

export const REPEAT_LABELS: Record<RepeatKind, string> = {
  once: 'Once',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
  custom: 'Custom (RRULE)',
  after_completion: 'After completion',
};

export const WEEKDAY_NAMES: Record<WeekdayCode, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
};

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Which week of the month for "the nth weekday"; -1 is the last. */
export const NTH_OPTIONS = [
  { value: 1, label: 'First' },
  { value: 2, label: 'Second' },
  { value: 3, label: 'Third' },
  { value: 4, label: 'Fourth' },
  { value: -1, label: 'Last' },
] as const;

export interface RecurrenceState {
  kind: RepeatKind;
  /** Every N days, weeks, months or years. `null` while the input is empty. */
  interval: number | null;
  /** Weekly: the days to repeat on. */
  weekdays: WeekdayCode[];
  /** Monthly: on a day of the month, or on the nth weekday. */
  monthlyMode: 'day' | 'weekday';
  /** Monthly and yearly: the day of the month (1 to 31), ignored when `lastDay`. */
  monthDay: number | null;
  lastDay: boolean;
  /** Monthly on the nth weekday: 1 to 4, or -1 for the last. */
  nth: number;
  nthWeekday: WeekdayCode;
  /** Yearly: 1 to 12. */
  month: number;
  /** Custom: the raw RRULE. */
  customRrule: string;
  /** After completion: days between finishing one and the next being due. */
  afterDays: number | null;
}

export function defaultRecurrence(kind: RepeatKind = 'once'): RecurrenceState {
  return {
    kind,
    interval: 1,
    weekdays: [],
    monthlyMode: 'day',
    monthDay: 1,
    lastDay: false,
    nth: 1,
    nthWeekday: 'MO',
    month: 1,
    customRrule: '',
    afterDays: 7,
  };
}

/** The scheduling fields of a task that the builder owns. */
export interface ScheduleFields {
  scheduleKind: 'once' | 'fixed' | 'after_completion';
  rrule: string | null;
  intervalAfterCompletionDays: number | null;
}

function whole(value: number | null, min: number, max: number, what: string): number {
  if (value === null || !Number.isInteger(value) || value < min || value > max) {
    throw new RecurrenceError(
      'invalid_argument',
      `${what} must be a whole number from ${min} to ${max}`,
    );
  }
  return value;
}

const UNIT: Partial<Record<RepeatKind, string>> = {
  daily: 'The number of days',
  weekly: 'The number of weeks',
  monthly: 'The number of months',
  yearly: 'The number of years',
};

/**
 * What the builder state stores. Throws `RecurrenceError` with a message fit to show next to the
 * form when the state is incomplete (no weekday chosen, an empty field, a blank custom rule).
 * A custom rule is only checked for being non-blank here; core validates its syntax.
 */
export function buildRecurrence(state: RecurrenceState): ScheduleFields {
  const fixed = (rrule: string): ScheduleFields => ({
    scheduleKind: 'fixed',
    rrule,
    intervalAfterCompletionDays: null,
  });
  const every = (): number => whole(state.interval, 1, 999, UNIT[state.kind] ?? 'The interval');
  const dayOfMonth = (): number =>
    state.lastDay ? -1 : whole(state.monthDay, 1, 31, 'The day of the month');

  switch (state.kind) {
    case 'once':
      return { scheduleKind: 'once', rrule: null, intervalAfterCompletionDays: null };
    case 'daily':
      return fixed(rrules.daily(every()));
    case 'weekly':
      if (state.weekdays.length === 0) {
        throw new RecurrenceError('invalid_argument', 'Pick at least one weekday');
      }
      return fixed(rrules.weekly(state.weekdays, every()));
    case 'monthly':
      return fixed(
        state.monthlyMode === 'day'
          ? rrules.monthlyOnDay(dayOfMonth(), every())
          : rrules.monthlyOnNthWeekday(state.nth, state.nthWeekday, every()),
      );
    case 'yearly':
      return fixed(rrules.yearly(state.month, dayOfMonth(), every()));
    case 'custom': {
      const rule = state.customRrule.trim();
      if (rule === '') {
        throw new RecurrenceError(
          'invalid_argument',
          'Enter a rule, for example FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
        );
      }
      return fixed(rule);
    }
    case 'after_completion':
      return {
        scheduleKind: 'after_completion',
        rrule: null,
        intervalAfterCompletionDays: whole(state.afterDays, 1, 3650, 'The number of days'),
      };
  }
}

const NTH_WEEKDAY = /^(-1|[1-4])(MO|TU|WE|TH|FR|SA|SU)$/;

/** Reads an RRULE into builder state if it is one the builder would write, else `null`. */
function parseRule(rrule: string): RecurrenceState | null {
  const text = rrule
    .trim()
    .replace(/^RRULE:/i, '')
    .toUpperCase();
  const pieces = text.split(';');
  // The builders always write INTERVAL (right after FREQ), so a rule without one reads as 1.
  if (pieces[0]?.startsWith('FREQ=') && !pieces.some((p) => p.startsWith('INTERVAL='))) {
    pieces.splice(1, 0, 'INTERVAL=1');
  }
  const parts = new Map<string, string>();
  for (const piece of pieces) {
    const [name, value, ...extra] = piece.split('=');
    if (!name || value === undefined || extra.length > 0) return null;
    parts.set(name, value);
  }

  const state = defaultRecurrence();
  state.interval = Number(parts.get('INTERVAL'));
  const monthDay = parts.get('BYMONTHDAY');
  const byDay = parts.get('BYDAY');
  const setMonthDay = (): void => {
    state.lastDay = monthDay === '-1';
    if (!state.lastDay) state.monthDay = Number(monthDay);
  };

  switch (parts.get('FREQ')) {
    case 'DAILY':
      state.kind = 'daily';
      break;
    case 'WEEKLY':
      state.kind = 'weekly';
      state.weekdays = (byDay?.split(',') ?? []).filter((d): d is WeekdayCode =>
        (WEEKDAY_CODES as readonly string[]).includes(d),
      );
      break;
    case 'MONTHLY': {
      state.kind = 'monthly';
      const nth = byDay === undefined ? null : NTH_WEEKDAY.exec(byDay);
      if (nth) {
        state.monthlyMode = 'weekday';
        state.nth = Number(nth[1]);
        state.nthWeekday = nth[2] as WeekdayCode;
      } else {
        setMonthDay();
      }
      break;
    }
    case 'YEARLY':
      state.kind = 'yearly';
      state.month = Number(parts.get('BYMONTH'));
      setMonthDay();
      break;
    default:
      return null;
  }

  // Only a rule the builder would write back exactly counts as one of its patterns: anything
  // else (extra parts, COUNT, a different order, an unsupported value) is custom.
  try {
    return buildRecurrence(state).rrule === pieces.join(';') ? state : null;
  } catch {
    return null;
  }
}

/** The builder state for a stored task: its pattern if it has one, else `custom` or `once`. */
export function parseRecurrence(task: ScheduleFields): RecurrenceState {
  if (task.scheduleKind === 'once') return defaultRecurrence('once');
  if (task.scheduleKind === 'after_completion') {
    return {
      ...defaultRecurrence('after_completion'),
      afterDays: task.intervalAfterCompletionDays,
    };
  }
  const rule = task.rrule ?? '';
  return parseRule(rule) ?? { ...defaultRecurrence('custom'), customRrule: rule };
}
