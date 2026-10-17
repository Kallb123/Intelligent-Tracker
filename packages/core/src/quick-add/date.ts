import * as chrono from 'chrono-node';
import { parseUkDate } from '@tracker/shared';
import { localToday } from '../day.js';
import { resolveZone } from '../recurrence/calendar.js';
import type { LocalDate } from '../recurrence/types.js';
import type { Span } from './spans.js';

/** `HH:MM`, 24-hour. */
type TimeOfDay = string;

export interface DatePiece extends Span {
  kind: 'date' | 'time';
}

export interface DateFound {
  /** A date the text named. A recurrence or a template may still move it to its first match. */
  date?: LocalDate;
  /** For a time on its own ("5pm"): the day chrono would give it (today, or tomorrow once passed). */
  impliedDate?: LocalDate;
  time?: TimeOfDay;
  pieces: DatePiece[];
}

// "1/11", "14/03/27", "1.11.2026": day first. Without a year only `/` is read as a date, so
// "09.30" stays a time and "3-4" a range.
const NUMERIC_DATE = /(?<![\d/.-])(\d{1,2})([/.-])(\d{1,2})(?:\2(\d{4}|\d{2}))?(?![\d/])/g;
// Chrono cannot place 29 Feb in a non-leap year, so it is read here.
const LEAP_DAY = /\b29(?:th)?\s+(?:of\s+)?feb(?:ruary)?\b(?!\s*,?\s*\d{4})/i;
// Words that make a date or time clearer when they come first: "due on 14/03", "by Friday".
const DATE_CONNECTOR = /\b(?:due(?:\s+(?:on|by))?|on|by|at|from|until|till|before)\s+$/i;
const ABBREVIATED_WEEKDAY = /^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)$/i;
const BARE_DURATION =
  /^(?:\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:second|minute|hour|day|week|fortnight|month|year)s?$/i;
// An hour with no am/pm, on the end or start of a phrase: "tomorrow at 5", "at 5 tomorrow".
const UNCLEAR_HOUR_END = /\s+(?:at\s+|@\s*)?\d{1,2}$/i;
const UNCLEAR_HOUR_START = /^(?:at\s+|@\s*)?\d{1,2}\s+/i;
// A clock time that is clear: "5pm", "17:30", "9.15", "noon", "tomorrow morning".
const CLEAR_TIME =
  /\d\s*(?:am|pm|a\.m\.|p\.m\.)|\d[:.h]\d|o'?clock|noon|midnight|morning|afternoon|evening|night/i;

// What a fraction or a count is of, not a date: "3/4 inch bolts", "1/2 price", "1/2 kg", "1/4 of".
// Units may be stuck to the number ("1/2kg") or be a quote mark ("3/4\"").
const MEASURE =
  /^\s*(?:["”″]|(?:inch(?:es)?|cm|mm|ft|foot|feet|yards?|m|metres?|meters?|miles?|kg|g|lbs?|oz|ml|l|litres?|liters?|pints?|cups?|tsp|tbsp|teaspoons?|tablespoons?|packs?|tins?|hours?|hrs?|minutes?|mins?|days?|weeks?|price|full|off|of)\b)/i;
// "in" is a unit only after a plain fraction ("3/4 in bolts"): "1/11 in London" is a date.
const INCH_ABBREVIATION = /^\s*in\b(?!\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i;
const FRACTION_DENOMINATORS = new Set([2, 4, 8, 16, 32, 64]);

const pad = (n: number): string => String(n).padStart(2, '0');

/** Moves `start` back over a connector word so "due on 14/03" leaves no "due on" in the title. */
function withConnector(text: string, start: number): number {
  const connector = DATE_CONNECTOR.exec(text.slice(0, start));
  return connector ? connector.index : start;
}

/** The part of a chrono result that is read here: what it matched, where, and what it means. */
type Candidate = Pick<chrono.ParsedResult, 'text' | 'index' | 'start'>;

/**
 * Chrono gives "tomorrow at 5" as one result with an hour it cannot place (5am or 5pm?). The day
 * is clear though, so the result is read again without the hour: "tomorrow" is the date and
 * "at 5" stays in the title. A result that is not a date plus an unclear hour is returned as is.
 */
function withoutUnclearHour(result: Candidate, parse: (text: string) => Candidate[]): Candidate[] {
  const { start: at, text } = result;
  const dateGiven = ['year', 'month', 'day', 'weekday'].some((k) => at.isCertain(k as 'day'));
  if (!dateGiven || !at.isCertain('hour') || CLEAR_TIME.test(text)) return [result];
  const head = UNCLEAR_HOUR_START.exec(text)?.[0].length ?? 0;
  const dateText = head > 0 ? text.slice(head) : text.replace(UNCLEAR_HOUR_END, '');
  if (dateText === text) return [result];
  const [date] = parse(dateText);
  if (date?.text !== dateText || date.index !== 0) return [result];
  return [{ text: date.text, start: date.start, index: result.index + head }];
}

interface Numeric {
  date: LocalDate;
  start: number;
  end: number;
}

/** True for a `d/d` that is a quantity or an idiom, not a day and month. */
function notADate(text: string, m: RegExpMatchArray): boolean {
  if (m[4] !== undefined || m[2] !== '/') return false;
  const after = text.slice((m.index as number) + m[0].length);
  const numerator = Number(m[1]);
  const denominator = Number(m[3]);
  // "open 24/7", but "due 24/7" is 24 July.
  if (numerator === 24 && denominator === 7) {
    return !DATE_CONNECTOR.test(text.slice(0, m.index));
  }
  if (numerator >= denominator) return false;
  return (
    MEASURE.test(after) || (FRACTION_DENOMINATORS.has(denominator) && INCH_ABBREVIATION.test(after))
  );
}

/** `text` with the `d/d`s that are not dates ("3/4 inch", "24/7") blanked, so nothing reads them. */
function blankNonDates(text: string): string {
  let out = text;
  for (const m of text.matchAll(NUMERIC_DATE)) {
    if (!notADate(text, m)) continue;
    const at = m.index as number;
    out = out.slice(0, at) + ' '.repeat(m[0].length) + out.slice(at + m[0].length);
  }
  return out;
}

function numericDate(text: string, today: LocalDate): Numeric | null {
  for (const m of text.matchAll(NUMERIC_DATE)) {
    // `/` may leave the year off; `.` and `-` are only dates with a four-digit year.
    if (m[2] !== '/' && m[4]?.length !== 4) continue;
    const date = parseUkDate(m[0], today);
    if (date) return { date, start: m.index, end: m.index + m[0].length };
  }
  const leap = LEAP_DAY.exec(text);
  const date = leap ? parseUkDate('29/02', today) : null;
  return leap && date ? { date, start: leap.index, end: leap.index + leap[0].length } : null;
}

/**
 * Finds the date, and the time if there is one, in `source`: UK day-first numeric dates first
 * (`1/11`, `14/03/27`, 29 Feb), then `chrono.en.GB` for everything spoken ("next Tuesday at
 * 3pm", "25th December", "in 2 weeks"). Dates without a year are the next one on or after today
 * in `timezone`. Matches that are probably not dates (a bare "Sun", "March", "2 weeks", "at 5"
 * with no am/pm) are ignored and left in the title, never guessed.
 */
export function findDateTime(source: string, now: Date, timezone: string): DateFound {
  const text = blankNonDates(source);
  const pieces: DatePiece[] = [];
  const found: DateFound = { pieces };
  const today = localToday(now, timezone);

  const numeric = numericDate(text, today);
  let rest = text;
  if (numeric) {
    const start = withConnector(text, numeric.start);
    found.date = numeric.date;
    pieces.push({ kind: 'date', start, end: numeric.end });
    rest = text.slice(0, start) + ' '.repeat(numeric.end - start) + text.slice(numeric.end);
  }

  // Chrono reads zone names only as abbreviations, so give it the zone's offset at `now` (minutes).
  const reference = { instant: now, timezone: resolveZone(timezone).offset(now.getTime()) };
  const parse = (t: string) => chrono.en.GB.parse(t, reference, { forwardDate: true });
  for (const result of parse(rest).flatMap((r) => withoutUnclearHour(r, parse))) {
    const { start: at } = result;
    const dateGiven = ['year', 'month', 'day', 'weekday'].some((k) => at.isCertain(k as 'day'));
    const timeGiven = at.isCertain('hour');
    const looksLikeDate =
      !ABBREVIATED_WEEKDAY.test(result.text) &&
      !BARE_DURATION.test(result.text) &&
      // "March", "next month", "Dec 25" (chrono reads the 25 as a year): too vague to be a due date.
      !(at.isCertain('month') && !at.isCertain('day') && !at.isCertain('weekday')) &&
      !(timeGiven && !CLEAR_TIME.test(result.text));
    if (!looksLikeDate) continue;

    const day = `${at.get('year')}-${pad(at.get('month') as number)}-${pad(at.get('day') as number)}`;
    const time = timeGiven
      ? `${pad(at.get('hour') as number)}:${pad(at.get('minute') ?? 0)}`
      : undefined;
    const start = withConnector(rest, result.index);
    const span = { start, end: result.index + result.text.length };

    if (dateGiven && found.date === undefined) {
      found.date = day;
      if (time !== undefined) found.time = time;
      pieces.push({ kind: 'date', ...span });
    } else if (!dateGiven && time !== undefined && found.time === undefined) {
      found.time = time;
      found.impliedDate ??= day;
      pieces.push({ kind: 'time', ...span });
    }
  }
  pieces.sort((a, b) => a.start - b.start);
  return found;
}
