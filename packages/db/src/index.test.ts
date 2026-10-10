import { HOUSEHOLD_DEFAULTS } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { DB_PACKAGE } from './index.js';

describe('db', () => {
  it('exports its package name and can import @tracker/shared', () => {
    expect(DB_PACKAGE).toBe('@tracker/db');
    expect(HOUSEHOLD_DEFAULTS.locale).toBe('en-GB');
  });
});
