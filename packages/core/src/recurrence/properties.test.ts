import fc from 'fast-check';
import { DateTime } from 'luxon';
import { describe, it } from 'vitest';
import { expect } from 'vitest';
import { nextAfterCompletion } from './after-completion.js';
import { rrules } from './builders.js';
import { dueKey } from './calendar.js';
import { expand, nextOccurrence } from './expand.js';
import { WEEKDAY_CODES } from './rrule-parse.js';
import { localParts } from './test-util.js';
import type { Due, FixedSchedule } from './types.js';

// Fixed seed: every CI run checks the same cases, and a failure prints its counterexample.
const RUNS = { seed: 20261010, numRuns: 150 };
const LONDON = 'Europe/London';
const DAY = 86_400_000;

const dateAt = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const londonDate = (instant: Date): string => localParts(instant, LONDON).date;

/** Instants from 2024 to 2031, on whole seconds. */
const instant = fc
  .integer({ min: Date.UTC(2024, 0, 1) / 1000, max: Date.UTC(2031, 0, 1) / 1000 })
  .map((seconds) => new Date(seconds * 1000));

const weekday = fc.constantFrom(...WEEKDAY_CODES);
const rule = fc.oneof(
  fc.integer({ min: 1, max: 40 }).map((n) => rrules.daily(n)),
  fc
    .tuple(fc.uniqueArray(weekday, { minLength: 1, maxLength: 7 }), fc.integer({ min: 1, max: 4 }))
    .map(([days, n]) => rrules.weekly(days, n)),
  fc
    .tuple(fc.integer({ min: 1, max: 31 }), fc.integer({ min: 1, max: 3 }))
    .map(([day, n]) => rrules.monthlyOnDay(day, n)),
  fc.integer({ min: 1, max: 3 }).map((n) => rrules.monthlyOnDay(-1, n)),
  fc
    .tuple(fc.constantFrom(1, 2, 3, 4, -1), weekday)
    .map(([nth, day]) => rrules.monthlyOnNthWeekday(nth, day)),
  fc
    .tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
    .map(([m, d]) => rrules.yearly(m, d)),
);

const start = fc.oneof(
  instant.map((at): Due => ({ allDay: false, at })),
  instant.map((at): Due => ({ allDay: true, date: dateAt(at.getTime()) })),
);

const schedule = fc
  .tuple(rule, start)
  .map(([rrule, from]): FixedSchedule => ({ kind: 'fixed', rrule, start: from }));

/** A window [from, to] of up to ~3 years, possibly starting before the schedule does. */
const window = fc
  .tuple(instant, fc.integer({ min: 0, max: 3 * 365 * 24 * 3600 }))
  .map(([from, seconds]) => ({ from, to: new Date(from.getTime() + seconds * 1000) }));

function inWindow(due: Due, from: Date, to: Date): boolean {
  return due.allDay
    ? due.date >= londonDate(from) && due.date <= londonDate(to)
    : due.at >= from && due.at <= to;
}

describe('expand properties', () => {
  it('returns sorted, unique dues that all lie in the window', () => {
    fc.assert(
      fc.property(schedule, window, (s, { from, to }) => {
        const dues = expand(s, { from, to });
        const keys = dues.map(dueKey);
        expect(new Set(keys).size).toBe(keys.length);
        for (const due of dues) {
          expect(inWindow(due, from, to)).toBe(true);
          expect(due.allDay).toBe(s.start.allDay);
        }
        // ISO dates and instants both sort lexicographically.
        const text = dues.map((due) => (due.allDay ? due.date : due.at.toISOString()));
        expect(text).toEqual([...text].sort());
        expect(
          text.every((value, index) => index === 0 || (text[index - 1] as string) < value),
        ).toBe(true);
      }),
      RUNS,
    );
  });

  it('never starts before the schedule start', () => {
    fc.assert(
      fc.property(schedule, window, (s, { from, to }) => {
        for (const due of expand(s, { from, to })) {
          if (due.allDay && s.start.allDay) expect(due.date >= s.start.date).toBe(true);
          if (!due.allDay && !s.start.allDay) expect(due.at >= s.start.at).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('is additive: expand[a,c] equals expand[a,b] followed by the rest of expand[b,c]', () => {
    fc.assert(
      fc.property(
        schedule,
        window,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (s, { from, to }, ratio) => {
          const middle = new Date(
            from.getTime() + Math.floor((to.getTime() - from.getTime()) * ratio),
          );
          const whole = expand(s, { from, to }).map(dueKey);
          const head = expand(s, { from, to: middle }).map(dueKey);
          const seen = new Set(head);
          const tail = expand(s, { from: middle, to })
            .map(dueKey)
            .filter((key) => !seen.has(key));
          expect([...head, ...tail]).toEqual(whole);
        },
      ),
      RUNS,
    );
  });

  it('agrees with nextOccurrence', () => {
    fc.assert(
      fc.property(schedule, instant, (s, after) => {
        const next = nextOccurrence(s, after);
        const horizon = new Date(after.getTime() + 9 * 366 * DAY);
        const strictlyAfter = (due: Due): boolean =>
          due.allDay ? due.date > londonDate(after) : due.at > after;
        const expected = expand(s, { from: after, to: horizon, limit: 20_000 }).find(strictlyAfter);
        expect(next === null ? null : dueKey(next)).toBe(
          expected === undefined ? null : dueKey(expected),
        );
      }),
      { ...RUNS, numRuns: 80 },
    );
  });

  it('keeps a daily timed rule at the same London wall-clock time, except in the spring gap', () => {
    const localTime = fc.record({
      year: fc.integer({ min: 2024, max: 2026 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
      hour: fc.integer({ min: 0, max: 23 }),
      minute: fc.integer({ min: 0, max: 59 }),
    });
    fc.assert(
      fc.property(localTime, fc.integer({ min: 1, max: 3 }), (parts, interval) => {
        const local = DateTime.fromObject(parts, { zone: LONDON });
        fc.pre(local.isValid && local.hour === parts.hour); // skip times that don't exist
        const s: FixedSchedule = {
          kind: 'fixed',
          rrule: rrules.daily(interval),
          start: { allDay: false, at: local.toJSDate() },
        };
        const wanted = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
        const dues = expand(s, {
          from: local.toJSDate(),
          to: new Date(local.toMillis() + 2 * 366 * DAY),
        });
        expect(dues.length).toBeGreaterThan(300 / interval);
        for (const due of dues) {
          if (due.allDay) throw new Error('expected timed dues');
          const found = localParts(due.at, LONDON);
          // The only legitimate difference: 01:xx on the spring-forward day becomes 02:xx.
          const springGap =
            parts.hour === 1 &&
            DateTime.fromJSDate(due.at, { zone: LONDON }).hour === 2 &&
            found.time === `02:${wanted.slice(3)}`;
          expect(springGap || found.time === wanted).toBe(true);
        }
      }),
      { ...RUNS, numRuns: 25 },
    );
  });

  it('never shifts all-day dates, whatever the zone or clock changes', () => {
    const zones = fc.constantFrom(LONDON, 'America/New_York', 'Australia/Sydney', 'Asia/Kolkata');
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9 }),
        zones,
        fc.integer({ min: 0, max: 700 }),
        (interval, timezone, offsetDays) => {
          const first = Date.UTC(2025, 0, 1) + offsetDays * DAY;
          const s: FixedSchedule = {
            kind: 'fixed',
            rrule: rrules.daily(interval),
            start: { allDay: true, date: dateAt(first) },
          };
          // Noon UTC lands on the same calendar date in all these zones.
          const dues = expand(s, {
            from: new Date(first + 12 * 3600_000),
            to: new Date(first + 800 * DAY + 12 * 3600_000),
            timezone,
          });
          const expected = Array.from({ length: Math.floor(800 / interval) + 1 }, (_, index) =>
            dateAt(first + index * interval * DAY),
          );
          expect(dues.map((due) => (due.allDay ? due.date : ''))).toEqual(expected);
        },
      ),
      RUNS,
    );
  });
});

describe('expand against independent oracles', () => {
  const daysInMonth = (year: number, month: number): number =>
    new Date(Date.UTC(year, month, 0)).getUTCDate();
  const wholeYears = {
    from: new Date('2026-01-01T12:00:00Z'),
    to: new Date('2033-12-31T12:00:00Z'),
  };

  it('monthly on day N fires exactly in months that have a day N', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 31 }), (day) => {
        const dues = expand(
          {
            kind: 'fixed',
            rrule: rrules.monthlyOnDay(day),
            start: { allDay: true, date: '2026-01-01' },
          },
          wholeYears,
        );
        const expected: string[] = [];
        for (let year = 2026; year <= 2033; year += 1) {
          for (let month = 1; month <= 12; month += 1) {
            if (day <= daysInMonth(year, month)) {
              expected.push(
                `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
              );
            }
          }
        }
        expect(dues.map((due) => (due.allDay ? due.date : ''))).toEqual(expected);
      }),
      { ...RUNS, numRuns: 31 },
    );
  });

  it('monthly on -1 is always the last day of the month', () => {
    const dues = expand(
      {
        kind: 'fixed',
        rrule: rrules.monthlyOnDay(-1),
        start: { allDay: true, date: '2026-01-01' },
      },
      wholeYears,
    );
    expect(dues).toHaveLength(96);
    for (const due of dues) {
      if (!due.allDay) throw new Error('expected all-day dues');
      const [year, month, day] = due.date.split('-').map(Number) as [number, number, number];
      expect(day).toBe(daysInMonth(year, month));
    }
  });

  it('weekly rules match a day-by-day scan (weeks start on Monday)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(weekday, { minLength: 1, maxLength: 7 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 0, max: 60 }),
        (days, interval, offset) => {
          const first = Date.UTC(2026, 0, 1) + offset * DAY; // some day in Jan/Feb/Mar 2026
          const s: FixedSchedule = {
            kind: 'fixed',
            rrule: rrules.weekly(days, interval),
            start: { allDay: true, date: dateAt(first) },
          };
          const dues = expand(s, {
            from: new Date(first + 12 * 3600_000),
            to: new Date(first + 400 * DAY + 12 * 3600_000),
          });
          const mondayIndex = (ms: number): number => Math.floor((ms / DAY + 3) / 7); // 1970-01-01 was a Thursday
          const expected: string[] = [];
          for (let ms = first; ms <= first + 400 * DAY; ms += DAY) {
            const code = WEEKDAY_CODES[(new Date(ms).getUTCDay() + 6) % 7];
            const week = mondayIndex(ms) - mondayIndex(first);
            if (days.includes(code as (typeof WEEKDAY_CODES)[number]) && week % interval === 0)
              expected.push(dateAt(ms));
          }
          expect(dues.map((due) => (due.allDay ? due.date : ''))).toEqual(expected);
        },
      ),
      RUNS,
    );
  });

  it('yearly on 29 February fires exactly in leap years', () => {
    const dues = expand(
      { kind: 'fixed', rrule: rrules.yearly(2, 29), start: { allDay: true, date: '2024-01-01' } },
      { from: new Date('2024-01-01T12:00:00Z'), to: new Date('2044-12-31T12:00:00Z') },
    );
    const leapYears = [2024, 2028, 2032, 2036, 2040, 2044];
    expect(dues.map((due) => (due.allDay ? due.date : ''))).toEqual(
      leapYears.map((year) => `${year}-02-29`),
    );
  });
});

describe('nextAfterCompletion properties', () => {
  it('lands interval days after the local completion date at the previous local time', () => {
    fc.assert(
      fc.property(
        instant,
        instant,
        fc.integer({ min: 1, max: 400 }),
        (completedAt, previous, intervalDays) => {
          const wall = localParts(previous, LONDON);
          const due = nextAfterCompletion({
            intervalDays,
            completedAt,
            previousDue: { allDay: false, at: previous },
          });
          if (due.allDay) throw new Error('expected a timed due');
          const found = localParts(due.at, LONDON);
          expect(found.date).toBe(
            dateAt(Date.parse(`${londonDate(completedAt)}T00:00:00Z`) + intervalDays * DAY),
          );
          // Equal local times, except a time inside the spring gap which moves forward an hour.
          const wanted = Number(wall.time.slice(0, 2));
          expect(
            found.time === wall.time || (wanted === 1 && found.time === `02:${wall.time.slice(3)}`),
          ).toBe(true);

          const allDayDue = nextAfterCompletion({
            intervalDays,
            completedAt,
            previousDue: { allDay: true, date: '2026-01-01' },
          });
          expect(allDayDue).toEqual({ allDay: true, date: found.date });
        },
      ),
      RUNS,
    );
  });
});
