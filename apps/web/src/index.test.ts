import { HOUSEHOLD_DEFAULTS } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { WEB_APP_NAME } from './index.js';

describe('web', () => {
  it('exports its name and can import @tracker/shared', () => {
    expect(WEB_APP_NAME).toBe('web');
    expect(HOUSEHOLD_DEFAULTS.timezone).toBe('Europe/London');
  });
});
