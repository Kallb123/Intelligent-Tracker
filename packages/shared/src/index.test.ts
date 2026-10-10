import { describe, expect, it } from 'vitest';
import { HOUSEHOLD_DEFAULTS } from './index.js';

describe('HOUSEHOLD_DEFAULTS', () => {
  it('uses UK defaults', () => {
    expect(HOUSEHOLD_DEFAULTS.timezone).toBe('Europe/London');
    expect(HOUSEHOLD_DEFAULTS.locale).toBe('en-GB');
    expect(HOUSEHOLD_DEFAULTS.slots.eveningDigest).toBe('19:00');
  });
});
