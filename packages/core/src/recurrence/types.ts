/** A calendar date with no time or zone, as `YYYY-MM-DD` (the shape of the `date` DB columns). */
export type LocalDate = string;

/**
 * When something is due. An all-day due is a plain calendar date (it never shifts with time
 * zones or DST); a timed due is an instant (UTC), matching `due_date` / `due_at` in the DB.
 */
export type Due = { allDay: true; date: LocalDate } | { allDay: false; at: Date };

export interface OnceSchedule {
  kind: 'once';
  /** `null` for an undated task. */
  due: Due | null;
}

export interface FixedSchedule {
  kind: 'fixed';
  /**
   * An RFC 5545 RRULE value such as `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO` (an `RRULE:` prefix is
   * allowed). DTSTART always comes from `start`, never from this string.
   */
  rrule: string;
  /** Anchor of the series: the date or time the rule is evaluated from. */
  start: Due;
}

export interface AfterCompletionSchedule {
  kind: 'after_completion';
  intervalDays: number;
  /** The first due. Later dues are computed from the last completion (`nextAfterCompletion`). */
  start: Due;
}

export type Schedule = OnceSchedule | FixedSchedule | AfterCompletionSchedule;

export interface ZoneOptions {
  /** IANA zone name. Defaults to `DEFAULT_TIMEZONE` (Europe/London). */
  timezone?: string | undefined;
}
