export type RecurrenceErrorCode =
  /** The RRULE string is malformed (unknown part, bad value, missing FREQ ...). */
  | 'invalid_rrule'
  /** The RRULE is valid RFC 5545 but outside what this engine supports (FREQ below DAILY, DTSTART ...). */
  | 'unsupported_rrule'
  /** Not an IANA time zone name. */
  | 'invalid_timezone'
  /** An invalid `Date` or a `YYYY-MM-DD` string that is not a real calendar date. */
  | 'invalid_date'
  /** A task row or schedule whose fields contradict each other. */
  | 'invalid_schedule'
  /** A bad option or builder argument (non-integer interval, limit out of range ...). */
  | 'invalid_argument';

/** Every failure in the recurrence engine is a `RecurrenceError`, so callers can branch on `code`. */
export class RecurrenceError extends Error {
  readonly code: RecurrenceErrorCode;

  constructor(code: RecurrenceErrorCode, message: string) {
    super(message);
    this.name = 'RecurrenceError';
    this.code = code;
  }
}

/** Throws `invalid_argument` unless `value` is an integer in `[min, max]`. */
export function assertInteger(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RecurrenceError(
      'invalid_argument',
      `${label} must be an integer between ${min} and ${max}, got ${String(value)}`,
    );
  }
}
