import { rrules } from '../recurrence/builders.js';
import { RecurrenceError } from '../recurrence/errors.js';
import type { WeekdayCode } from '../recurrence/rrule-parse.js';
import type { Span } from './spans.js';
import { COUNT, toCount, UNIT, UNIT_DAYS, WEEKDAY, WEEKDAY_LIST, weekdaysIn } from './words.js';
import type { Unit } from './words.js';

/** What a recurrence phrase asks for, before it is tied to a date. */
export type RecurrencePattern =
  /** A complete rule: it names its own weekdays or days of the month. */
  | { kind: 'rrule'; rrule: string }
  /** Every `interval` days, weeks, months or years, on the day of the date it is anchored to. */
  | { kind: 'interval'; unit: 'day' | 'week' | 'month' | 'year'; interval: number }
  | { kind: 'after_completion'; days: number };

export interface RecurrenceFound extends Span {
  pattern: RecurrencePattern;
}

interface Rule {
  pattern: RegExp;
  /** May throw `RecurrenceError` for a count or day the builders refuse ("every 0 days"). */
  build: (match: RegExpExecArray) => RecurrencePattern;
}

const MAX_AFTER_COMPLETION_DAYS = 3650;
/** The largest `INTERVAL` the `rrules` builders take. */
const MAX_INTERVAL = 999;
const WEEKDAYS: WeekdayCode[] = ['MO', 'TU', 'WE', 'TH', 'FR'];
const WEEKEND: WeekdayCode[] = ['SA', 'SU'];
const ORDINALS: Record<string, number> = {
  first: 1,
  '1st': 1,
  second: 2,
  '2nd': 2,
  third: 3,
  '3rd': 3,
  fourth: 4,
  '4th': 4,
  last: -1,
};
const ORDINAL = Object.keys(ORDINALS).join('|');
const OTHER = 'other|second|2nd|alternate';
// "it's done", "it is done", "done", "completed", "completion", "ticked off".
const AFTER_DONE = `(?:after|once)\\s+(?:(?:it|this|that)(?:\\s*['’]s|\\s+is|\\s+was|\\s+gets|\\s+got|\\s+has\\s+been)?\\s+)?(?:done|completed|complete|finished|completion|ticked\\s+off)`;

/** A fortnight is two weeks, so the rule needs only days, weeks, months and years. */
function interval(count: number, unit: Unit): RecurrencePattern {
  if (count < 1 || count > MAX_INTERVAL * (unit === 'fortnight' ? 0.5 : 1)) {
    throw new RecurrenceError('invalid_argument', 'interval out of range');
  }
  return unit === 'fortnight'
    ? { kind: 'interval', unit: 'week', interval: count * 2 }
    : { kind: 'interval', unit, interval: count };
}

/** Same ceiling as the api's `intervalAfterCompletionDays`. */
function afterCompletion(days: number): RecurrencePattern {
  if (days < 1 || days > MAX_AFTER_COMPLETION_DAYS) {
    throw new RecurrenceError('invalid_argument', 'interval out of range');
  }
  return { kind: 'after_completion', days };
}

const unitOf = (word: string): Unit => word.toLowerCase() as Unit;

const RULES: Rule[] = [
  // "every 6 weeks after done", "a month after it's done", "once done" after a length of time.
  {
    pattern: new RegExp(
      `\\b(?:(?:every|each)\\s+)?(?:(${COUNT})\\s+)?(${UNIT})s?\\s+${AFTER_DONE}\\b`,
      'iu',
    ),
    build: (m) => afterCompletion(toCount(m[1] ?? '1') * UNIT_DAYS[unitOf(m[2] as string)]),
  },
  // "last Friday of the month", "first Monday of every month".
  {
    pattern: new RegExp(
      `\\b(?:on\\s+)?(?:the\\s+)?(?:(?:every|each)\\s+)?(${ORDINAL})\\s+(${WEEKDAY})s?\\s+of\\s+(?:the|every|each)\\s+month\\b`,
      'iu',
    ),
    build: (m) => ({
      kind: 'rrule',
      rrule: rrules.monthlyOnNthWeekday(
        ORDINALS[(m[1] as string).toLowerCase()] as number,
        weekdaysIn(m[2] as string)[0] as WeekdayCode,
      ),
    }),
  },
  // "every last Friday", "every first Monday". "Every second Tuesday" is every other Tuesday.
  {
    pattern: new RegExp(
      `\\b(?:every|each)\\s+(first|1st|third|3rd|fourth|4th|last)\\s+(${WEEKDAY})\\b`,
      'iu',
    ),
    build: (m) => ({
      kind: 'rrule',
      rrule: rrules.monthlyOnNthWeekday(
        ORDINALS[(m[1] as string).toLowerCase()] as number,
        weekdaysIn(m[2] as string)[0] as WeekdayCode,
      ),
    }),
  },
  // "last day of the month".
  {
    pattern: /\b(?:on\s+)?(?:the\s+)?last\s+day\s+of\s+(?:the|every|each)\s+month\b/iu,
    build: () => ({ kind: 'rrule', rrule: rrules.monthlyOnDay(-1) }),
  },
  // "on the 15th of every month", "every month on the 15th", "monthly on the 15th".
  {
    pattern:
      /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\s+of\s+(?:every|each)\s+month\b|\b(?:(?:every|each)\s+month|monthly)\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b/iu,
    build: (m) => ({
      kind: 'rrule',
      rrule: rrules.monthlyOnDay(Number(m[1] ?? m[2])),
    }),
  },
  // "on weekdays", "every weekday", "Monday to Friday".
  {
    pattern:
      /\b(?:on\s+weekdays|(?:every|each)\s+week\s*day|weekdays|(?:every\s+)?monday\s+(?:to|-|through)\s+friday)\b/iu,
    build: () => ({ kind: 'rrule', rrule: rrules.weekly(WEEKDAYS) }),
  },
  {
    pattern: /\b(?:on\s+weekends|(?:every|each)\s+weekend|weekends)\b/iu,
    build: () => ({ kind: 'rrule', rrule: rrules.weekly(WEEKEND) }),
  },
  // "every other Tuesday", "every second Monday and Thursday".
  {
    pattern: new RegExp(`\\b(?:every|each)\\s+(?:${OTHER})\\s+(${WEEKDAY_LIST})\\b`, 'iu'),
    build: (m) => ({ kind: 'rrule', rrule: rrules.weekly(weekdaysIn(m[1] as string), 2) }),
  },
  // "every other week", "every second month".
  {
    pattern: new RegExp(`\\b(?:every|each)\\s+(?:${OTHER})\\s+(${UNIT})\\b`, 'iu'),
    build: (m) => interval(2, unitOf(m[1] as string)),
  },
  // "every 2 weeks on Tuesday", "every week on Monday and Thursday", "weekly on Friday".
  {
    pattern: new RegExp(
      `\\b(?:(?:every|each)\\s+(?:(${COUNT})\\s+)?weeks?|weekly)\\s+on\\s+(${WEEKDAY_LIST})\\b`,
      'iu',
    ),
    build: (m) => ({
      kind: 'rrule',
      rrule: rrules.weekly(weekdaysIn(m[2] as string), toCount(m[1] ?? '1')),
    }),
  },
  // "every Tuesday", "every Monday and Thursday".
  {
    pattern: new RegExp(`\\b(?:every|each)\\s+(${WEEKDAY_LIST})\\b`, 'iu'),
    build: (m) => ({ kind: 'rrule', rrule: rrules.weekly(weekdaysIn(m[1] as string)) }),
  },
  // "Tuesdays", "on Fridays".
  {
    pattern: /\b(?:on\s+)?(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/iu,
    build: (m) => ({ kind: 'rrule', rrule: rrules.weekly(weekdaysIn(m[0])) }),
  },
  // "every day", "every 6 weeks", "every fortnight", "each year".
  {
    pattern: new RegExp(`\\b(?:every|each)\\s+(?:(${COUNT})\\s+)?(${UNIT})s?\\b`, 'iu'),
    build: (m) => interval(toCount(m[1] ?? '1'), unitOf(m[2] as string)),
  },
  // "once a week", "once a year".
  {
    pattern: /\bonce\s+(?:a|per|every)\s+(day|week|month|year)\b/iu,
    build: (m) => interval(1, unitOf(m[1] as string)),
  },
  // "daily", "weekly", "fortnightly", "monthly", "yearly", "annually".
  {
    pattern: /\b(daily|weekly|fortnightly|monthly|yearly|annually)\b/iu,
    build: (m) => {
      const word = (m[1] as string).toLowerCase();
      const unit = { daily: 'day', weekly: 'week', fortnightly: 'fortnight', monthly: 'month' }[
        word
      ];
      return interval(1, (unit ?? 'year') as Unit);
    },
  },
];

/**
 * Finds the first recurrence phrase in `text` (the earliest, and the longest where several start
 * together, so "every 6 weeks after done" is one phrase and not "every 6 weeks" plus junk).
 * Returns the pattern and where it is, or null. Pure text reading; no dates are involved yet.
 */
export function findRecurrence(text: string): RecurrenceFound | null {
  let best: RecurrenceFound | null = null;
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const found = { start: match.index, end: match.index + match[0].length };
    if (
      best &&
      (found.start > best.start || (found.start === best.start && found.end <= best.end))
    ) {
      continue;
    }
    try {
      best = { ...found, pattern: rule.build(match) };
    } catch (error) {
      // A phrase the builders refuse ("every 0 days", "the 45th of every month") is not one.
      if (!(error instanceof RecurrenceError)) throw error;
    }
  }
  return best;
}
