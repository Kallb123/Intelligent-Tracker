import type { WeekdayCode } from '../recurrence/rrule-parse.js';

/** Small counts people type as words: "a month before", "every two weeks". */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
};

/** Regex source for a count: digits or a number word. */
export const COUNT = `\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')}`;

export function toCount(word: string): number {
  return NUMBER_WORDS[word.toLowerCase()] ?? Number(word);
}

/** Days in a unit when a length of time is needed ("a month before" is 30, as the templates use). */
export const UNIT_DAYS = { day: 1, week: 7, fortnight: 14, month: 30, year: 365 } as const;
export type Unit = keyof typeof UNIT_DAYS;

/** Regex source for a unit name (singular; callers add `s?`). */
export const UNIT = Object.keys(UNIT_DAYS).join('|');

/** Regex source for one weekday name: Mon, Tues, Thursday ... */
export const WEEKDAY =
  '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';

/** Regex source for "Monday", "Monday and Thursday", "Mon, Wed & Fri". */
export const WEEKDAY_LIST = `${WEEKDAY}s?(?:\\s*(?:,|&|,?\\s+and)\\s*${WEEKDAY}s?)*`;

/** The weekday codes named in `text`, in the order written (duplicates removed). */
export function weekdaysIn(text: string): WeekdayCode[] {
  const found = [...text.matchAll(new RegExp(`\\b${WEEKDAY}s?\\b`, 'gi'))].map(
    (m) => m[0].slice(0, 2).toUpperCase() as WeekdayCode,
  );
  return [...new Set(found)];
}
