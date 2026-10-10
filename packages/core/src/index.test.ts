import { HOUSEHOLD_DEFAULTS } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE, expand, rrules } from './index.js';

describe('core', () => {
  it('resolves workspace packages (@tracker/shared)', () => {
    expect(DEFAULT_TIMEZONE).toBe('Europe/London');
    expect(DEFAULT_TIMEZONE).toBe(HOUSEHOLD_DEFAULTS.timezone);
  });

  it('exports the recurrence engine', () => {
    const schedule = {
      kind: 'fixed',
      rrule: rrules.daily(),
      start: { allDay: true, date: '2026-07-01' },
    } as const;
    const dues = expand(schedule, {
      from: new Date('2026-07-01T12:00:00Z'),
      to: new Date('2026-07-02T12:00:00Z'),
    });
    expect(dues).toHaveLength(2);
  });
});
