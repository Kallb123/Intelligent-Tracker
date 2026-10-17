import type { DigestKind } from '@tracker/shared';
import {
  addDays,
  assertValidInstant,
  fromWall,
  localDateOf,
  parseLocalDate,
  resolveZone,
} from '../recurrence/calendar.js';
import type { LocalDate } from '../recurrence/types.js';
import { parseTimeOfDay } from './slots.js';

/*
 * When the scheduled digests go out, as a pure function of the clock. The bot asks it on every
 * delivery tick and sends what is due, once per household and local date (the digest log makes
 * it once; this only says which digests are in their window).
 */

/**
 * How long after its slot a digest is still sent. The bot ticks every few seconds, so this only
 * matters when it was down or the send failed: a digest that is a couple of hours late is still
 * useful, one from the afternoon is not.
 */
export const DIGEST_GRACE_MS = 2 * 60 * 60 * 1000;

export interface DueDigest {
  kind: DigestKind;
  /** The household-local date the digest is for (and the log's key). */
  localDate: LocalDate;
}

export interface DueDigestsInput {
  now: Date;
  /** IANA zone name of the household. Defaults to `DEFAULT_TIMEZONE` (Europe/London). */
  timezone?: string;
  /** `HH:MM` or `HH:MM:SS`. The morning digest goes out at the morning slot. */
  morningSlot: string;
  /** The Sunday "week ahead" goes out at the evening slot. */
  eveningSlot: string;
}

/**
 * The digests whose window contains `now`, morning digest first:
 *
 * - `morning`: every day, from the morning slot on the local date until `DIGEST_GRACE_MS` after;
 * - `week_ahead`: the same window from the evening slot, on Sundays only.
 *
 * A slot is placed on a date the way the planner places its reminders (`fromWall`), so on a day
 * the clocks change a time that does not exist moves forward by the gap. A window can run past
 * midnight (a 23:30 slot), so yesterday's is checked as well and keeps yesterday's date. Throws
 * `RecurrenceError` for an invalid `now`, zone or slot.
 */
export function dueDigests(input: DueDigestsInput): DueDigest[] {
  const { now, timezone } = input;
  assertValidInstant(now, 'now');
  const zone = resolveZone(timezone);
  const morning = parseTimeOfDay(input.morningSlot, 'morningSlot');
  const evening = parseTimeOfDay(input.eveningSlot, 'eveningSlot');
  const today = localDateOf(zone, now);

  const inWindow = (date: LocalDate, slot: number): boolean => {
    const start = fromWall(zone, parseLocalDate(date) + slot);
    return start <= now.getTime() && now.getTime() < start + DIGEST_GRACE_MS;
  };
  const isSunday = (date: LocalDate): boolean => new Date(parseLocalDate(date)).getUTCDay() === 0;

  const due: DueDigest[] = [];
  for (const [kind, slot, onDate] of [
    ['morning', morning, () => true],
    ['week_ahead', evening, isSunday],
  ] as const) {
    for (const localDate of [addDays(today, -1), today]) {
      if (onDate(localDate) && inWindow(localDate, slot)) due.push({ kind, localDate });
    }
  }
  return due;
}
