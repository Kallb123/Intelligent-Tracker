import { IANAZone } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertValidDue,
  assertValidInstant,
  comparatorTo,
  dueFromWall,
  dueKey,
  formatLocalDate,
  fromWall,
  localDateOf,
  parseLocalDate,
  resolveZone,
  timeOfDayOf,
  toWall,
  wallOfDue,
} from './calendar.js';
import { RecurrenceError } from './errors.js';
import { allDay, at, show, timed } from './test-util.js';

const london = IANAZone.create('Europe/London');
const wall = (iso: string): number => Date.parse(`${iso}Z`);

describe('resolveZone', () => {
  it('defaults to Europe/London and accepts any IANA zone', () => {
    expect(resolveZone(undefined).name).toBe('Europe/London');
    expect(resolveZone('America/New_York').name).toBe('America/New_York');
  });

  it.each(['Mars/Olympus', '', 'GMT+5 maybe'])('rejects %j', (name) => {
    expect(() => resolveZone(name)).toThrow(RecurrenceError);
    try {
      resolveZone(name);
    } catch (error) {
      expect((error as RecurrenceError).code).toBe('invalid_timezone');
    }
  });
});

describe('local dates', () => {
  it('round trips valid dates, including leap days', () => {
    expect(formatLocalDate(parseLocalDate('2028-02-29'))).toBe('2028-02-29');
  });

  it.each(['2026-02-30', '2027-02-29', '2026-13-01', '26-01-01', '2026-1-1', 'tomorrow', ''])(
    'rejects %j',
    (text) => {
      expect(() => parseLocalDate(text)).toThrow(/valid YYYY-MM-DD/);
    },
  );

  it('adds and subtracts days across month, year and leap boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2028-02-28', 2)).toBe('2028-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('finds the local date of an instant in the zone', () => {
    // 23:30Z on 1 July is already 2 July in London (BST) but still 1 July in New York.
    const instant = at('2026-07-01T23:30:00Z');
    expect(localDateOf(london, instant)).toBe('2026-07-02');
    expect(localDateOf(resolveZone('America/New_York'), instant)).toBe('2026-07-01');
  });
});

describe('wall time conversion', () => {
  it('maps instants to wall time and back outside DST changes', () => {
    expect(new Date(toWall(london, at('2026-07-01T07:00:00Z').getTime())).toISOString()).toBe(
      '2026-07-01T08:00:00.000Z',
    );
    expect(new Date(fromWall(london, wall('2026-07-01T08:00:00'))).toISOString()).toBe(
      '2026-07-01T07:00:00.000Z',
    );
    expect(new Date(fromWall(london, wall('2026-01-15T08:00:00'))).toISOString()).toBe(
      '2026-01-15T08:00:00.000Z',
    );
  });

  it('gives the milliseconds after local midnight', () => {
    const hours = (h: number) => h * 3_600_000;
    expect(timeOfDayOf(london, at('2026-07-01T07:30:00Z').getTime())).toBe(hours(8.5));
    expect(timeOfDayOf(london, at('2026-01-15T00:00:00Z').getTime())).toBe(0);
    expect(timeOfDayOf(london, at('2026-07-01T23:30:00Z').getTime())).toBe(hours(0.5));
    // Before 1970 the wall time is negative; the result is still a time of day.
    expect(timeOfDayOf(london, at('1960-01-01T12:00:00Z').getTime())).toBe(hours(12));
  });

  it('keeps clock times before and after the spring change correct (2026-03-29)', () => {
    expect(new Date(fromWall(london, wall('2026-03-29T00:30:00'))).toISOString()).toBe(
      '2026-03-29T00:30:00.000Z',
    );
    expect(new Date(fromWall(london, wall('2026-03-29T12:00:00'))).toISOString()).toBe(
      '2026-03-29T11:00:00.000Z',
    );
  });

  it('moves a time inside the spring gap forward (01:30 -> 02:30 BST)', () => {
    const resolved = new Date(fromWall(london, wall('2026-03-29T01:30:00')));
    expect(resolved.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(new Date(toWall(london, resolved.getTime())).toISOString()).toBe(
      '2026-03-29T02:30:00.000Z',
    );
  });

  it('picks the first, BST instant for a time that happens twice (2026-10-25)', () => {
    const resolved = new Date(fromWall(london, wall('2026-10-25T01:30:00')));
    expect(resolved.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    // ...and 02:30 the same morning is unambiguous GMT.
    expect(new Date(fromWall(london, wall('2026-10-25T02:30:00'))).toISOString()).toBe(
      '2026-10-25T02:30:00.000Z',
    );
  });

  it('works for a zone on the other side of the Atlantic', () => {
    const newYork = resolveZone('America/New_York');
    // US clocks spring forward on 2026-03-08 (02:00 -> 03:00) and fall back on 2026-11-01.
    expect(new Date(fromWall(newYork, wall('2026-03-08T02:30:00'))).toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
    expect(new Date(fromWall(newYork, wall('2026-11-01T01:30:00'))).toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });
});

describe('dues', () => {
  it('converts between dues and wall time', () => {
    expect(wallOfDue(london, allDay('2026-07-01'))).toBe(wall('2026-07-01T00:00:00'));
    expect(wallOfDue(london, timed('2026-07-01T07:00:00Z'))).toBe(wall('2026-07-01T08:00:00'));
    expect(show([dueFromWall(london, true, wall('2026-07-01T08:00:00'))])).toEqual(['2026-07-01']);
    expect(show([dueFromWall(london, false, wall('2026-07-01T08:00:00'))])).toEqual([
      '2026-07-01T07:00:00.000Z',
    ]);
  });

  it('validates dues and instants', () => {
    expect(() => assertValidDue(allDay('2026-07-01'))).not.toThrow();
    expect(() => assertValidDue(timed('2026-07-01T07:00:00Z'))).not.toThrow();
    expect(() => assertValidDue(allDay('2026-02-30'))).toThrow(RecurrenceError);
    expect(() => assertValidDue({ allDay: false, at: new Date('nope') })).toThrow(/invalid Date/);
    expect(() => assertValidInstant(new Date('nope'), 'x')).toThrow(RecurrenceError);
  });

  it('gives all-day and timed dues distinct keys', () => {
    expect(dueKey(allDay('2026-07-01'))).not.toBe(dueKey(timed('2026-07-01T00:00:00Z')));
    expect(dueKey(timed('2026-07-01T00:00:00Z'))).toBe(dueKey(timed('2026-07-01T00:00:00Z')));
  });

  it('compares all-day dues by local date and timed dues by instant', () => {
    const against = comparatorTo(london, at('2026-07-01T23:30:00Z')); // local date 2026-07-02
    expect(against(allDay('2026-07-01'))).toBeLessThan(0);
    expect(against(allDay('2026-07-02'))).toBe(0);
    expect(against(allDay('2026-07-03'))).toBeGreaterThan(0);
    expect(against(timed('2026-07-01T23:29:59Z'))).toBeLessThan(0);
    expect(against(timed('2026-07-01T23:30:00Z'))).toBe(0);
    expect(against(timed('2026-07-01T23:30:01Z'))).toBeGreaterThan(0);
  });
});
