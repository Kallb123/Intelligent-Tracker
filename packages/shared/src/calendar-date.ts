/**
 * en-GB formatting of calendar dates (`YYYY-MM-DD`), shared by the web app and the Telegram bot.
 * Pure `Intl`, so it runs in the browser and in Node alike.
 */

export const LOCALE = 'en-GB';

const calendarParts = new Intl.DateTimeFormat(LOCALE, {
  // A bare `YYYY-MM-DD` is a calendar date, not an instant: read it as UTC so no zone shifts it.
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** The calendar date `YYYY-MM-DD` as its parts, or undefined when it is not a real date. */
function calendarFields(date: string): Record<string, string> | undefined {
  const instant = new Date(`${date}T00:00:00Z`);
  // Date rolls 30 February over to 2 March; a round trip catches that.
  if (
    Number.isNaN(instant.getTime()) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    instant.toISOString().slice(0, 10) !== date
  ) {
    return undefined;
  }
  return Object.fromEntries(calendarParts.formatToParts(instant).map((p) => [p.type, p.value]));
}

/** `1 Nov 2026` for a calendar date (`YYYY-MM-DD`). Empty string if it is not a real date. */
export function formatCalendarDate(date: string): string {
  const f = calendarFields(date);
  return f ? `${f['day']} ${f['month']} ${f['year']}` : '';
}

/**
 * `Mon 12 Oct` for a calendar date, the heading of a day in the lists. The year is added when it
 * differs from `today`'s (so a date next January is not mistaken for this one), or always with
 * `alwaysYear`.
 */
export function formatDayHeading(date: string, today?: string, alwaysYear = false): string {
  const f = calendarFields(date);
  if (!f) return '';
  const day = `${f['weekday']} ${f['day']} ${f['month']}`;
  return alwaysYear || (today !== undefined && today.slice(0, 4) !== date.slice(0, 4))
    ? `${day} ${f['year']}`
    : day;
}

/** `DD/MM`, `D/M`, `DD/MM/YY` or `DD/MM/YYYY`, with `/`, `-` or `.` between the parts. */
const UK_DATE = /^(\d{1,2})([/.-])(\d{1,2})(?:\2(\d{2}|\d{4}))?$/;

/** A real `YYYY-MM-DD` for the parts, or null (31/02, month 13, ...). */
function isoDate(year: number, month: number, day: number): string | null {
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return calendarFields(iso) ? iso : null;
}

/**
 * Reads a date typed the UK way, day first (`5/11`, `05.11.26`, `5-11-2026`), as `YYYY-MM-DD`;
 * null when it is not one or not a real date (`31/02`). A two-digit year means 20YY. Without a
 * year it is the next such date on or after `today` (`YYYY-MM-DD`, the household's local date),
 * so "5/11" typed on 6 November means next year, and 29/02 waits for the next leap year. Only
 * the day and month ever come from the text when the year is missing, so there is no ambiguity
 * with the US month-first order to guess at: `12/10` is 12 October.
 */
export function parseUkDate(text: string, today: string): string | null {
  const match = UK_DATE.exec(text.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[3]);
  const yearText = match[4];
  if (yearText !== undefined) {
    return isoDate(yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText), month, day);
  }
  const thisYear = Number(today.slice(0, 4));
  // A leap day is at most 8 years away (a century year that is not a leap year, e.g. 2100).
  for (let year = thisYear; year <= thisYear + 8; year++) {
    const iso = isoDate(year, month, day);
    if (iso === null && !(month === 2 && day === 29)) return null;
    if (iso !== null && iso >= today) return iso;
  }
  return null;
}
