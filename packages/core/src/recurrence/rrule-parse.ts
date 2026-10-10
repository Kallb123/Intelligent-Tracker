import type { IANAZone } from 'luxon';
import rrule from 'rrule';
import type { Options } from 'rrule';
import { MAX_WALL, MS_PER_DAY, toWall } from './calendar.js';
import { RecurrenceError } from './errors.js';

// rrule ships a CommonJS build that Node's ESM loader exposes only through the default export.
const { RRule, Weekday } = rrule;

export const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

/** A validated RRULE, ready to hand to rrule once DTSTART (and a bound) are known. */
export interface ParsedRule {
  options: Partial<Options>;
  /** `UNTIL` as written (UTC), or `null`. */
  until: Date | null;
  /** True when `UNTIL` was a bare date (`20261231`): inclusive through that whole local day. */
  untilIsDate: boolean;
}

const FREQUENCIES: Record<string, number> = {
  DAILY: RRule.DAILY,
  WEEKLY: RRule.WEEKLY,
  MONTHLY: RRule.MONTHLY,
  YEARLY: RRule.YEARLY,
};
const SUB_DAILY = new Set(['HOURLY', 'MINUTELY', 'SECONDLY']);
// Times of day come from the schedule's start, and week/year-day selectors are not needed.
const UNSUPPORTED_PARTS = new Set(['BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYWEEKNO', 'BYYEARDAY']);
const SUPPORTED_PARTS = new Set([
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'BYDAY',
  'BYMONTHDAY',
  'BYMONTH',
  'BYSETPOS',
  'WKST',
]);
// Properties that make a string a full iCalendar fragment rather than one RRULE value.
const FOREIGN_PROPERTY = /DTSTART|TZID|EXDATE|RDATE|EXRULE|[\r\n]/i;
// Longest each month can be (February counts 29), to spot BYMONTH + BYMONTHDAY that never match.
const MAX_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const UNSIGNED = /^[1-9]\d{0,5}$/;
const SIGNED = /^[+-]?\d{1,3}$/;
const BYDAY_ITEM = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/;
const UNTIL_VALUE = /^(\d{8})(?:T(\d{6})Z?)?$/;

function invalid(message: string): never {
  throw new RecurrenceError('invalid_rrule', message);
}

function positive(part: string, value: string): number {
  return UNSIGNED.test(value) ? Number(value) : invalid(`${part} must be a positive integer`);
}

/** A comma list of non-zero integers within [min, max]; `undefined` when the part is absent. */
function integerList(
  part: string,
  value: string | undefined,
  min: number,
  max: number,
): number[] | undefined {
  return value?.split(',').map((item) => {
    const n = SIGNED.test(item) ? Number(item) : Number.NaN;
    return n !== 0 && n >= min && n <= max
      ? n
      : invalid(`${part} values must be non-zero integers from ${min} to ${max}`);
  });
}

function weekdayIndex(code: string): number {
  return WEEKDAY_CODES.indexOf(code as WeekdayCode);
}

function parseByDay(value: string): InstanceType<typeof Weekday>[] {
  return value.split(',').map((item) => {
    const match = BYDAY_ITEM.exec(item);
    if (!match) return invalid(`BYDAY has an invalid value: ${item}`);
    const nth = match[1] === undefined ? undefined : Number(match[1]);
    if (nth !== undefined && (nth === 0 || Math.abs(nth) > 53)) {
      return invalid(`BYDAY ordinal must be between 1 and 53 (or -1 to -53): ${item}`);
    }
    return new Weekday(weekdayIndex(match[2] as string), nth);
  });
}

function parseUntil(value: string): { until: Date; isDate: boolean } {
  const match = UNTIL_VALUE.exec(value);
  if (!match) return invalid(`UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSSZ, got ${value}`);
  const date = match[1] as string;
  const time = match[2] ?? '000000';
  const until = new Date(
    Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(4, 6)) - 1,
      Number(date.slice(6, 8)),
      Number(time.slice(0, 2)),
      Number(time.slice(2, 4)),
      Number(time.slice(4, 6)),
    ),
  );
  // Date.UTC rolls impossible values over (month 13, hour 25 ...), which a round trip exposes.
  if (until.toISOString().replace(/[-:]/g, '').slice(0, 15) !== `${date}T${time}`) {
    return invalid(`UNTIL is not a real date: ${value}`);
  }
  return { until, isDate: match[2] === undefined };
}

/**
 * Parses and validates one RRULE value. Supported parts: FREQ (DAILY..YEARLY), INTERVAL, COUNT,
 * UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS and WKST. Anything else is rejected with a
 * `RecurrenceError` rather than being silently ignored.
 */
export function parseRRule(text: string): ParsedRule {
  if (FOREIGN_PROPERTY.test(text)) {
    throw new RecurrenceError(
      'unsupported_rrule',
      'Pass only the RRULE value: DTSTART, TZID, EXDATE and multiple lines are not supported',
    );
  }
  const parts = new Map<string, string>();
  for (const piece of text
    .trim()
    .replace(/^RRULE:/i, '')
    .split(';')) {
    const match = /^([A-Za-z]+)=(.+)$/.exec(piece);
    if (!match) return invalid(`Not a NAME=VALUE rule part: ${JSON.stringify(piece)}`);
    const name = (match[1] as string).toUpperCase();
    if (parts.has(name)) return invalid(`Duplicate rule part ${name}`);
    parts.set(name, (match[2] as string).toUpperCase());
  }
  for (const name of parts.keys()) {
    if (UNSUPPORTED_PARTS.has(name)) {
      throw new RecurrenceError('unsupported_rrule', `${name} is not supported`);
    }
    if (!SUPPORTED_PARTS.has(name)) return invalid(`Unknown rule part ${name}`);
  }

  const freq = parts.get('FREQ') ?? '';
  if (SUB_DAILY.has(freq)) {
    throw new RecurrenceError('unsupported_rrule', `FREQ=${freq} is not supported (DAILY minimum)`);
  }
  const frequency = FREQUENCIES[freq];
  if (frequency === undefined) return invalid('FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY');
  if (parts.has('COUNT') && parts.has('UNTIL')) return invalid('COUNT and UNTIL are exclusive');

  const options: Partial<Options> = { freq: frequency, wkst: RRule.MO };
  const interval = parts.get('INTERVAL');
  if (interval !== undefined) options.interval = positive('INTERVAL', interval);
  const count = parts.get('COUNT');
  if (count !== undefined) options.count = positive('COUNT', count);
  const byDay = parts.get('BYDAY');
  if (byDay !== undefined) options.byweekday = parseByDay(byDay);
  const monthDays = integerList('BYMONTHDAY', parts.get('BYMONTHDAY'), -31, 31);
  const months = integerList('BYMONTH', parts.get('BYMONTH'), 1, 12);
  if (monthDays) options.bymonthday = monthDays;
  if (months) options.bymonth = months;
  const setPositions = integerList('BYSETPOS', parts.get('BYSETPOS'), -366, 366);
  if (setPositions) options.bysetpos = setPositions;
  if (
    monthDays &&
    months &&
    !months.some((month) =>
      monthDays.some((day) => day < 0 || day <= (MAX_DAYS_IN_MONTH[month - 1] as number)),
    )
  ) {
    return invalid('BYMONTH and BYMONTHDAY never match (for example 30 February)');
  }
  const wkst = parts.get('WKST');
  if (wkst !== undefined) {
    if (weekdayIndex(wkst) < 0) return invalid(`WKST must be a weekday code, got ${wkst}`);
    options.wkst = weekdayIndex(wkst);
  }
  const untilText = parts.get('UNTIL');
  if (untilText === undefined) return { options, until: null, untilIsDate: false };
  const { until, isDate } = parseUntil(untilText);
  return { options, until, untilIsDate: isDate };
}

/**
 * The last wall time the rule may produce. A date-only UNTIL runs through the end of that local
 * day; a date-time UNTIL is a UTC instant converted into the zone's wall time.
 */
export function untilWall(rule: ParsedRule, zone: IANAZone): number {
  if (rule.until === null) return MAX_WALL;
  return rule.untilIsDate
    ? rule.until.getTime() + MS_PER_DAY - 1
    : toWall(zone, rule.until.getTime());
}

export { RRule };
