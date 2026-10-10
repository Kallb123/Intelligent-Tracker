import { describe, expect, it } from 'vitest';
import { startupMessage } from './index.js';

describe('worker', () => {
  it('builds a startup message using @tracker/core', () => {
    expect(startupMessage()).toBe('[worker] starting (timezone: Europe/London)');
  });
});
