import { describe, expect, it } from 'vitest';
import { suggestLeadTime } from './effort.js';

describe('suggestLeadTime', () => {
  it.each([
    [null, null],
    [undefined, null],
    [0, null],
    [59, null],
    [60, 3],
    [179, 3],
    [180, 7],
    [1440, 7],
    [1441, null],
    [NaN, null],
    [Infinity, null],
    [60.5, null],
  ])('effort %s proposes %s days', (effortMinutes, expected) => {
    expect(suggestLeadTime({ effortMinutes, leadTimeDays: null })).toBe(expected);
  });
  it.each([0, 1, 30])('respects an explicit lead of %s days', (leadTimeDays) => {
    expect(suggestLeadTime({ effortMinutes: 240, leadTimeDays })).toBeNull();
  });
  it('accepts an omitted lead without mutating the task', () => {
    const task = { effortMinutes: 60, leadTimeDays: undefined };
    expect(suggestLeadTime(task)).toBe(3);
    expect(task.leadTimeDays).toBeUndefined();
  });
});
