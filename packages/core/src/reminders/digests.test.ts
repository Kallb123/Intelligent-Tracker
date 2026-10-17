import { describe, expect, it } from 'vitest';
import { RecurrenceError } from '../recurrence/errors.js';
import { at } from '../recurrence/test-util.js';
import { DIGEST_GRACE_MS, dueDigests, type DueDigestsInput } from './index.js';

const slots = { morningSlot: '08:00', eveningSlot: '19:00' };

/** The due digests as `kind date` strings, for readable table rows. */
function due(now: string, o: Partial<DueDigestsInput> = {}): string[] {
  return dueDigests({ now: at(now), timezone: 'Europe/London', ...slots, ...o }).map(
    (d) => `${d.kind} ${d.localDate}`,
  );
}

// 2026: the clocks go forward on Sunday 29 March and back on Sunday 25 October.
describe('the morning digest', () => {
  it.each<[string, string, string[]]>([
    ['a minute before the slot (BST)', '2026-10-14T06:59:00Z', []],
    ['at the slot (BST)', '2026-10-14T07:00:00Z', ['morning 2026-10-14']],
    ['inside the window', '2026-10-14T08:00:00Z', ['morning 2026-10-14']],
    ['the last millisecond of the window', '2026-10-14T08:59:59.999Z', ['morning 2026-10-14']],
    ['at the end of the window', '2026-10-14T09:00:00Z', []],
    ['midday', '2026-10-14T11:00:00Z', []],
    ['at the slot (GMT)', '2026-11-04T08:00:00Z', ['morning 2026-11-04']],
    ['a minute before the slot (GMT)', '2026-11-04T07:59:00Z', []],
  ])('%s', (_name, now, expected) => {
    expect(due(now)).toEqual(expected);
  });

  it('is due every day of the week', () => {
    // Monday 12 to Sunday 18 October, 08:00 BST each (07:00Z).
    for (let day = 12; day <= 18; day++) {
      expect(due(`2026-10-${day}T07:00:00Z`)[0]).toBe(`morning 2026-10-${day}`);
    }
  });

  it('takes the household time zone, not UTC, to decide the date', () => {
    // 08:00 on the 15th in Sydney (AEDT, +11) is 21:00 UTC on the 14th.
    expect(due('2026-10-14T20:59:00Z', { timezone: 'Australia/Sydney' })).toEqual([]);
    expect(due('2026-10-14T21:00:00Z', { timezone: 'Australia/Sydney' })).toEqual([
      'morning 2026-10-15',
    ]);
  });

  it('reads slots with seconds, and the default zone is London', () => {
    const now = at('2026-10-14T07:00:00Z');
    expect(
      dueDigests({ now, morningSlot: '08:00:00', eveningSlot: '19:00:00' }).map((d) => d.kind),
    ).toEqual(['morning']);
  });
});

describe('the week ahead digest', () => {
  it.each<[string, string, string[]]>([
    ['Sunday, a minute before the evening slot (BST)', '2026-10-18T17:59:00Z', []],
    ['Sunday at the evening slot (BST)', '2026-10-18T18:00:00Z', ['week_ahead 2026-10-18']],
    [
      'Sunday, last millisecond of the window',
      '2026-10-18T19:59:59.999Z',
      ['week_ahead 2026-10-18'],
    ],
    ['Sunday at the end of the window', '2026-10-18T20:00:00Z', []],
    ['Sunday at the evening slot (GMT)', '2026-11-01T19:00:00Z', ['week_ahead 2026-11-01']],
    ['Monday at the evening slot', '2026-10-19T18:00:00Z', []],
    ['Saturday at the evening slot', '2026-10-17T18:00:00Z', []],
    ['Sunday morning: only the morning digest', '2026-10-18T07:00:00Z', ['morning 2026-10-18']],
  ])('%s', (_name, now, expected) => {
    expect(due(now)).toEqual(expected);
  });

  it('is not due on weekdays', () => {
    // Monday 12 to Saturday 17 October at the evening slot.
    for (let day = 12; day <= 17; day++) {
      expect(due(`2026-10-${day}T18:00:00Z`)).toEqual([]);
    }
  });
});

describe('both slots at once', () => {
  it('lists the morning digest first when the windows overlap', () => {
    expect(due('2026-10-18T07:30:00Z', { morningSlot: '08:00', eveningSlot: '08:30' })).toEqual([
      'morning 2026-10-18',
      'week_ahead 2026-10-18',
    ]);
  });
});

describe('windows that cross midnight', () => {
  const late = { morningSlot: '23:30', eveningSlot: '23:30' };

  it('keeps the date of the day the slot was on', () => {
    // 00:30 BST on Monday 19th: still inside Sunday's window.
    expect(due('2026-10-18T23:30:00Z', late)).toEqual([
      'morning 2026-10-18',
      'week_ahead 2026-10-18',
    ]);
    expect(due('2026-10-19T23:30:00Z', late)).toEqual(['morning 2026-10-19']);
  });

  it('does not make a Saturday window a Sunday one', () => {
    // 00:30 BST on Sunday 18th: Saturday's morning digest is still open, no week ahead.
    expect(due('2026-10-17T23:30:00Z', late)).toEqual(['morning 2026-10-17']);
  });

  it('is over after the grace period', () => {
    expect(due('2026-10-19T01:30:00Z', late)).toEqual([]);
  });
});

describe('clock changes', () => {
  it('places a slot that does not exist after the gap (spring forward)', () => {
    // 01:30 on 29 March 2026 does not exist: it is 02:30 BST, which is 01:30Z.
    const early = { morningSlot: '01:30', eveningSlot: '01:30' };
    expect(due('2026-03-29T01:29:00Z', early)).toEqual([]);
    expect(due('2026-03-29T01:30:00Z', early)).toEqual([
      'morning 2026-03-29',
      'week_ahead 2026-03-29',
    ]);
  });

  it('uses the first of a time that happens twice (autumn)', () => {
    // 01:30 on 25 October 2026 is first 01:30 BST (00:30Z).
    const early = { morningSlot: '01:30', eveningSlot: '01:30' };
    expect(due('2026-10-25T00:29:00Z', early)).toEqual([]);
    expect(due('2026-10-25T00:30:00Z', early)).toEqual([
      'morning 2026-10-25',
      'week_ahead 2026-10-25',
    ]);
  });

  it('still fires at the usual local times on a clock-change Sunday', () => {
    // 29 March: 08:00 BST is 07:00Z, 19:00 BST is 18:00Z.
    expect(due('2026-03-29T07:00:00Z')).toEqual(['morning 2026-03-29']);
    expect(due('2026-03-29T18:00:00Z')).toEqual(['week_ahead 2026-03-29']);
    // 25 October: 08:00 GMT is 08:00Z, 19:00 GMT is 19:00Z.
    expect(due('2026-10-25T08:00:00Z')).toEqual(['morning 2026-10-25']);
    expect(due('2026-10-25T19:00:00Z')).toEqual(['week_ahead 2026-10-25']);
  });
});

describe('invalid input', () => {
  it.each<[string, Partial<DueDigestsInput>]>([
    ['now', { now: new Date(Number.NaN) }],
    ['a time zone', { timezone: 'Mars/Olympus' }],
    ['a morning slot', { morningSlot: '8am' }],
    ['an evening slot', { eveningSlot: '19:00:60' }],
  ])('throws for a bad %s', (_name, overrides) => {
    expect(() => due('2026-10-14T07:00:00Z', overrides)).toThrow(RecurrenceError);
  });

  it('has a grace period of two hours', () => {
    expect(DIGEST_GRACE_MS).toBe(2 * 60 * 60 * 1000);
  });
});
