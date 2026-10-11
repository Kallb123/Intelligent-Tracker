/**
 * en-GB date and time formatting. Everything is rendered in the household's time zone (not the
 * browser's), so two housemates always see the same wall-clock time for a task.
 */

export const LOCALE = 'en-GB';
export const DEFAULT_TIME_ZONE = 'Europe/London';

type DateInput = Date | string | number;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, withTime: boolean): Intl.DateTimeFormat {
  const key = `${timeZone}|${withTime}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      // 'h23' avoids midnight rendering as "24:00" in some engines.
      ...(withTime && { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const }),
    });
    formatters.set(key, f);
  }
  return f;
}

function toDate(value: DateInput): Date | undefined {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `31/12/2026`. Empty string for an invalid date, so a bad value never breaks a page. */
export function formatDate(value: DateInput, timeZone = DEFAULT_TIME_ZONE): string {
  const date = toDate(value);
  return date ? formatter(timeZone, false).format(date) : '';
}

/** `31/12/2026, 14:30` (24-hour clock). */
export function formatDateTime(value: DateInput, timeZone = DEFAULT_TIME_ZONE): string {
  const date = toDate(value);
  return date ? formatter(timeZone, true).format(date) : '';
}

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

const UNITS: readonly { unit: Intl.RelativeTimeFormatUnit; seconds: number }[] = [
  { unit: 'day', seconds: 86_400 },
  { unit: 'hour', seconds: 3_600 },
  { unit: 'minute', seconds: 60 },
];

/** "in 2 hours", "yesterday", "now": the distance from `now` in the largest whole unit. */
export function formatRelative(value: DateInput, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return '';
  const diffSeconds = Math.round((date.getTime() - now.getTime()) / 1000);
  for (const { unit, seconds } of UNITS) {
    if (Math.abs(diffSeconds) >= seconds)
      return relative.format(Math.trunc(diffSeconds / seconds), unit);
  }
  return relative.format(0, 'second');
}
