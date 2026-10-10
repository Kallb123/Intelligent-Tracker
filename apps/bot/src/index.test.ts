import { describe, expect, it } from 'vitest';
import { startupMessage } from './index.js';

describe('bot', () => {
  it('builds a startup message using @tracker/core', () => {
    expect(startupMessage()).toBe('[bot] starting (timezone: Europe/London)');
  });
});
