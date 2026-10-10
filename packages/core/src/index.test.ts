import { HOUSEHOLD_DEFAULTS } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE } from './index.js';

describe('core', () => {
  it('resolves workspace packages (@tracker/shared)', () => {
    expect(DEFAULT_TIMEZONE).toBe('Europe/London');
    expect(DEFAULT_TIMEZONE).toBe(HOUSEHOLD_DEFAULTS.timezone);
  });
});
