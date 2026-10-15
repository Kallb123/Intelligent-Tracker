import { addLocalDays, localToday } from '../day.js';
import { fromWall, parseLocalDate, resolveZone } from '../recurrence/calendar.js';
import { parseTimeOfDay } from './slots.js';

/** The snooze choices offered on a reminder, in the order they are shown. */
export const SNOOZE_OPTION_KEYS = ['tonight', 'tomorrow', 'weekend', '3d'] as const;

export type SnoozeOptionKey = (typeof SNOOZE_OPTION_KEYS)[number];

export interface SnoozeOptionsInput {
  now: Date;
  /** The household's IANA zone; the choices are household local times. */
  timezone: string;
  /** The household's evening slot, `HH:MM` or `HH:MM:SS`; every choice snoozes until it. */
  eveningSlot: string;
}

export interface SnoozeOption {
  key: SnoozeOptionKey;
  until: Date;
}

const SATURDAY = 6;

/** Days from the local date `today` to the next Saturday strictly after it (1 to 7). */
function daysToWeekend(today: string): number {
  const weekday = new Date(parseLocalDate(today)).getUTCDay();
  return ((SATURDAY - weekday + 6) % 7) + 1;
}

/**
 * The instant a snooze choice lasts until, or undefined when it is not offered: `tonight` once
 * the evening slot has passed. Always the evening slot, on the household's local date:
 * - `tonight`: today
 * - `tomorrow`: tomorrow
 * - `weekend`: the next Saturday after today (tomorrow on a Friday, the following Saturday on a
 *   Saturday or Sunday)
 * - `3d`: three days from today
 * Calendar days, so DST changes never shift the slot. Throws `RecurrenceError` for an invalid
 * `now`, unknown zone or malformed `eveningSlot`.
 */
export function snoozeUntil(key: SnoozeOptionKey, input: SnoozeOptionsInput): Date | undefined {
  const { now, timezone, eveningSlot } = input;
  const slot = parseTimeOfDay(eveningSlot, 'eveningSlot');
  const today = localToday(now, timezone);
  const days = { tonight: 0, tomorrow: 1, weekend: daysToWeekend(today), '3d': 3 }[key];
  const until = new Date(
    fromWall(resolveZone(timezone), parseLocalDate(addLocalDays(today, days)) + slot),
  );
  return key === 'tonight' && until <= now ? undefined : until;
}

/** The snooze choices available at `now`, in display order (see `snoozeUntil`). */
export function snoozeOptions(input: SnoozeOptionsInput): SnoozeOption[] {
  return SNOOZE_OPTION_KEYS.flatMap((key) => {
    const until = snoozeUntil(key, input);
    return until ? [{ key, until }] : [];
  });
}
