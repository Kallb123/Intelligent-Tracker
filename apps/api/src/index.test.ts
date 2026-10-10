import { describe, expect, it } from 'vitest';
import { startupMessage } from './index.js';

describe('api', () => {
  it('builds a startup message using @tracker/core', () => {
    expect(startupMessage()).toBe('[api] starting (timezone: Europe/London)');
  });
});
