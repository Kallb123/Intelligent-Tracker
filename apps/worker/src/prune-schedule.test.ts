import { describe, expect, it } from 'vitest';
import { createPruneSchedule, PRUNE_INTERVAL_MS } from './prune-schedule.js';

const at = (ms: number): Date => new Date(Date.UTC(2026, 6, 6) + ms);

describe('createPruneSchedule', () => {
  it('is due until a sweep has run', () => {
    const schedule = createPruneSchedule();
    expect(schedule.due(at(0))).toBe(true);
    expect(schedule.due(at(1000))).toBe(true);
  });

  it('is due again once the interval has passed since the last sweep', () => {
    const schedule = createPruneSchedule();
    schedule.done(at(0));

    expect(schedule.due(at(1))).toBe(false);
    expect(schedule.due(at(PRUNE_INTERVAL_MS - 1))).toBe(false);
    expect(schedule.due(at(PRUNE_INTERVAL_MS))).toBe(true);
  });

  it('measures the interval from the latest sweep', () => {
    const schedule = createPruneSchedule(1000);
    schedule.done(at(0));
    schedule.done(at(5000));

    expect(schedule.due(at(5999))).toBe(false);
    expect(schedule.due(at(6000))).toBe(true);
  });

  it('prunes at most once an hour by default', () => {
    expect(PRUNE_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});
