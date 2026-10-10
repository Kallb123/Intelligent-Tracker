import { describe, expect, it } from 'vitest';
import { nextAfterCompletion } from './after-completion.js';
import { RecurrenceError } from './errors.js';
import { allDay, at, localParts, show, timed } from './test-util.js';

describe('nextAfterCompletion', () => {
  it('adds the interval to the completion date for all-day tasks (drifts when completed late)', () => {
    const base = { intervalDays: 42, previousDue: allDay('2026-09-01') };
    // Due 1 Sept, done on time:
    expect(
      show([nextAfterCompletion({ ...base, completedAt: at('2026-09-01T10:00:00Z') })]),
    ).toEqual(['2026-10-13']);
    // ...done 9 days late, so the next one moves 9 days later:
    expect(
      show([nextAfterCompletion({ ...base, completedAt: at('2026-09-10T10:00:00Z') })]),
    ).toEqual(['2026-10-22']);
  });

  it('uses the local date of completion, not the UTC date', () => {
    const input = { intervalDays: 1, previousDue: allDay('2026-07-01') };
    // 23:30Z on 1 July is already 2 July in London...
    expect(
      show([nextAfterCompletion({ ...input, completedAt: at('2026-07-01T23:30:00Z') })]),
    ).toEqual(['2026-07-03']);
    // ...but still 1 July in New York.
    expect(
      show([
        nextAfterCompletion({
          ...input,
          completedAt: at('2026-07-01T23:30:00Z'),
          timezone: 'America/New_York',
        }),
      ]),
    ).toEqual(['2026-07-02']);
  });

  it('keeps the previous local wall-clock time for timed tasks across a clock change', () => {
    // Done on 2026-03-20 (GMT); the next due is 14 days later, after the clocks went forward.
    const due = nextAfterCompletion({
      intervalDays: 14,
      completedAt: at('2026-03-20T09:00:00Z'),
      previousDue: timed('2026-03-18T19:00:00Z'), // 19:00 GMT
    });
    expect(show([due])).toEqual(['2026-04-03T18:00:00.000Z']); // 19:00 BST
    expect(due.allDay ? '' : localParts(due.at, 'Europe/London')).toEqual({
      date: '2026-04-03',
      time: '19:00',
    });
  });

  it('copes with a previous due before 1970 and a gap-day result', () => {
    const early = nextAfterCompletion({
      intervalDays: 1,
      completedAt: at('1969-12-30T12:00:00Z'),
      previousDue: timed('1969-12-01T09:30:00Z'),
    });
    expect(show([early])).toEqual(['1969-12-31T09:30:00.000Z']);
    // 01:30 local landing on the spring-forward day resolves to 02:30 BST.
    const gap = nextAfterCompletion({
      intervalDays: 1,
      completedAt: at('2026-03-28T12:00:00Z'),
      previousDue: timed('2026-03-01T01:30:00Z'),
    });
    expect(show([gap])).toEqual(['2026-03-29T01:30:00.000Z']);
  });

  it('rejects bad input', () => {
    const ok = {
      intervalDays: 7,
      completedAt: at('2026-07-01T00:00:00Z'),
      previousDue: allDay('2026-07-01'),
    };
    for (const bad of [
      { ...ok, intervalDays: 0 },
      { ...ok, intervalDays: 1.5 },
      { ...ok, intervalDays: 3651 },
      { ...ok, completedAt: new Date('x') },
      { ...ok, previousDue: { allDay: false as const, at: new Date('x') } },
      { ...ok, timezone: 'No/Where' },
    ]) {
      expect(() => nextAfterCompletion(bad)).toThrow(RecurrenceError);
    }
  });
});
