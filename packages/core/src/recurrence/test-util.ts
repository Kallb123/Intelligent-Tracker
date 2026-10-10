import type { Due } from './types.js';

/** A UTC instant from an ISO string. */
export const at = (iso: string): Date => new Date(iso);

/** A timed due. */
export const timed = (iso: string): Due => ({ allDay: false, at: new Date(iso) });

/** An all-day due. */
export const allDay = (date: string): Due => ({ allDay: true, date });

/** Dues as plain strings (ISO instants / dates) for readable assertions. */
export const show = (dues: readonly (Due | null)[]): (string | null)[] =>
  dues.map((due) => (due === null ? null : due.allDay ? due.date : due.at.toISOString()));

/** Local date (`YYYY-MM-DD`) and time (`HH:MM`) of an instant, via Intl rather than the engine. */
export function localParts(instant: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}
