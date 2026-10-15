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
