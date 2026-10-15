import { describe, expect, it } from 'vitest';
import { RecurrenceError } from '../recurrence/errors.js';
import {
  SNOOZE_OPTION_KEYS,
  snoozeOptions,
  snoozeUntil,
  type SnoozeOptionKey,
  type SnoozeOptionsInput,
} from './index.js';

const london = (now: string, eveningSlot = '19:00'): SnoozeOptionsInput => ({
  now: new Date(now),
  timezone: 'Europe/London',
  eveningSlot,
});

type Case = {
  name: string;
  now: string;
  /** UTC instants, `undefined` where the choice is not offered. */
  expected: Record<SnoozeOptionKey, string | undefined>;
};

// 2026: the clocks go forward on Sunday 29 March and back on Sunday 25 October.
const cases: Case[] = [
  {
    name: 'Thursday afternoon in BST',
    now: '2026-10-15T12:00:00Z',
    expected: {
      tonight: '2026-10-15T18:00:00Z',
      tomorrow: '2026-10-16T18:00:00Z',
      weekend: '2026-10-17T18:00:00Z',
      '3d': '2026-10-18T18:00:00Z',
    },
  },
  {
    name: 'Friday: the weekend is tomorrow',
    now: '2026-10-16T09:00:00Z',
    expected: {
      tonight: '2026-10-16T18:00:00Z',
      tomorrow: '2026-10-17T18:00:00Z',
      weekend: '2026-10-17T18:00:00Z',
      '3d': '2026-10-19T18:00:00Z',
    },
  },
  {
    name: 'Saturday: the weekend is the following Saturday',
    now: '2026-10-17T09:00:00Z',
    expected: {
      tonight: '2026-10-17T18:00:00Z',
      tomorrow: '2026-10-18T18:00:00Z',
      weekend: '2026-10-24T18:00:00Z',
      '3d': '2026-10-20T18:00:00Z',
    },
  },
  {
    name: 'Sunday: the weekend is six days away',
    now: '2026-10-18T09:00:00Z',
    expected: {
      tonight: '2026-10-18T18:00:00Z',
      tomorrow: '2026-10-19T18:00:00Z',
      weekend: '2026-10-24T18:00:00Z',
      '3d': '2026-10-21T18:00:00Z',
    },
  },
  {
    name: 'Monday: the weekend is five days away',
    now: '2026-10-19T09:00:00Z',
    expected: {
      tonight: '2026-10-19T18:00:00Z',
      tomorrow: '2026-10-20T18:00:00Z',
      weekend: '2026-10-24T18:00:00Z',
      '3d': '2026-10-22T18:00:00Z',
    },
  },
  {
    name: 'Friday before the clocks go back: later choices are at 19:00 GMT',
    now: '2026-10-23T09:00:00Z',
    expected: {
      tonight: '2026-10-23T18:00:00Z',
      tomorrow: '2026-10-24T18:00:00Z',
      weekend: '2026-10-24T18:00:00Z',
      '3d': '2026-10-26T19:00:00Z',
    },
  },
  {
    name: 'Saturday before the clocks go back',
    now: '2026-10-24T09:00:00Z',
    expected: {
      tonight: '2026-10-24T18:00:00Z',
      tomorrow: '2026-10-25T19:00:00Z',
      weekend: '2026-10-31T19:00:00Z',
      '3d': '2026-10-27T19:00:00Z',
    },
  },
  {
    name: 'the day the clocks go back (GMT again by the evening)',
    now: '2026-10-25T09:00:00Z',
    expected: {
      tonight: '2026-10-25T19:00:00Z',
      tomorrow: '2026-10-26T19:00:00Z',
      weekend: '2026-10-31T19:00:00Z',
      '3d': '2026-10-28T19:00:00Z',
    },
  },
  {
    name: 'Saturday before the clocks go forward',
    now: '2026-03-28T09:00:00Z',
    expected: {
      tonight: '2026-03-28T19:00:00Z',
      tomorrow: '2026-03-29T18:00:00Z',
      weekend: '2026-04-04T18:00:00Z',
      '3d': '2026-03-31T18:00:00Z',
    },
  },
  {
    name: 'Friday before the clocks go forward',
    now: '2026-03-27T09:00:00Z',
    expected: {
      tonight: '2026-03-27T19:00:00Z',
      tomorrow: '2026-03-28T19:00:00Z',
      weekend: '2026-03-28T19:00:00Z',
      '3d': '2026-03-30T18:00:00Z',
    },
  },
  {
    name: 'the evening slot already passed: no tonight',
    now: '2026-10-15T18:30:00Z',
    expected: {
      tonight: undefined,
      tomorrow: '2026-10-16T18:00:00Z',
      weekend: '2026-10-17T18:00:00Z',
      '3d': '2026-10-18T18:00:00Z',
    },
  },
  {
    name: 'exactly at the evening slot: no tonight (it must be after now)',
    now: '2026-10-15T18:00:00Z',
    expected: {
      tonight: undefined,
      tomorrow: '2026-10-16T18:00:00Z',
      weekend: '2026-10-17T18:00:00Z',
      '3d': '2026-10-18T18:00:00Z',
    },
  },
  {
    name: 'a second before the evening slot: tonight is still offered',
    now: '2026-10-15T17:59:59Z',
    expected: {
      tonight: '2026-10-15T18:00:00Z',
      tomorrow: '2026-10-16T18:00:00Z',
      weekend: '2026-10-17T18:00:00Z',
      '3d': '2026-10-18T18:00:00Z',
    },
  },
  {
    name: 'after midnight local time is already the next local day',
    // 23:30 UTC on Thursday is 00:30 BST on Friday.
    now: '2026-10-15T23:30:00Z',
    expected: {
      tonight: '2026-10-16T18:00:00Z',
      tomorrow: '2026-10-17T18:00:00Z',
      weekend: '2026-10-17T18:00:00Z',
      '3d': '2026-10-19T18:00:00Z',
    },
  },
];

describe('snoozeOptions', () => {
  it.each(cases)('$name', ({ now, expected }) => {
    const options = snoozeOptions(london(now));
    expect(options.map((o) => [o.key, o.until.toISOString()])).toEqual(
      SNOOZE_OPTION_KEYS.flatMap((key) => {
        const until = expected[key];
        return until === undefined ? [] : [[key, new Date(until).toISOString()]];
      }),
    );
    for (const key of SNOOZE_OPTION_KEYS) {
      expect(snoozeUntil(key, london(now))?.toISOString()).toBe(
        expected[key] === undefined ? undefined : new Date(expected[key]).toISOString(),
      );
    }
  });

  it('lists the choices in display order, all after now', () => {
    const input = london('2026-10-15T12:00:00Z');
    const options = snoozeOptions(input);
    expect(options.map((o) => o.key)).toEqual(['tonight', 'tomorrow', 'weekend', '3d']);
    for (const option of options) expect(option.until.getTime()).toBeGreaterThan(+input.now);
  });

  it('accepts a Postgres time (HH:MM:SS) and any evening slot', () => {
    const options = snoozeOptions(london('2026-10-15T12:00:00Z', '20:30:00'));
    expect(options.map((o) => o.until.toISOString())).toEqual([
      '2026-10-15T19:30:00.000Z',
      '2026-10-16T19:30:00.000Z',
      '2026-10-17T19:30:00.000Z',
      '2026-10-18T19:30:00.000Z',
    ]);
  });

  it('uses the household zone, not UTC', () => {
    // 19:00 in New York is 23:00 UTC in EDT; on 1 November the clocks go back (EST, 00:00 UTC next day).
    const options = snoozeOptions({
      now: new Date('2026-10-30T12:00:00Z'),
      timezone: 'America/New_York',
      eveningSlot: '19:00',
    });
    expect(options.map((o) => o.until.toISOString())).toEqual([
      '2026-10-30T23:00:00.000Z',
      '2026-10-31T23:00:00.000Z',
      '2026-10-31T23:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
    ]);
  });

  it('rejects a bad slot, zone or instant', () => {
    expect(() => snoozeOptions(london('2026-10-15T12:00:00Z', '7pm'))).toThrow(RecurrenceError);
    expect(() => snoozeOptions({ ...london('2026-10-15T12:00:00Z'), timezone: 'Nowhere' })).toThrow(
      RecurrenceError,
    );
    expect(() => snoozeOptions(london('not a date'))).toThrow(RecurrenceError);
  });
});
