import { describe, expect, it } from 'vitest';
import { TestClock } from '../test-util.js';
import { FailureLimiter } from './rate-limiter.js';

const MINUTE = 60_000;

function setup(overrides: { limit?: number; maxKeys?: number } = {}) {
  const clock = new TestClock();
  const limiter = new FailureLimiter({
    limit: overrides.limit ?? 3,
    windowMs: 10 * MINUTE,
    clock: clock.now,
    ...(overrides.maxKeys ? { maxKeys: overrides.maxKeys } : {}),
  });
  return { clock, limiter };
}

describe('FailureLimiter', () => {
  it('allows failures up to the limit, then blocks until the window ends', () => {
    const { clock, limiter } = setup();
    for (let i = 0; i < 3; i++) {
      expect(limiter.retryAfterMs('a')).toBe(0);
      limiter.recordFailure('a');
    }
    expect(limiter.retryAfterMs('a')).toBe(10 * MINUTE);

    clock.advance(4 * MINUTE);
    expect(limiter.retryAfterMs('a')).toBe(6 * MINUTE);

    clock.advance(6 * MINUTE);
    expect(limiter.retryAfterMs('a')).toBe(0);
  });

  it('starts a fresh window after the old one lapses', () => {
    const { clock, limiter } = setup({ limit: 2 });
    limiter.recordFailure('a');
    clock.advance(11 * MINUTE);
    limiter.recordFailure('a');
    expect(limiter.retryAfterMs('a')).toBe(0); // one failure in the new window, not two
    limiter.recordFailure('a');
    expect(limiter.retryAfterMs('a')).toBeGreaterThan(0);
  });

  it('tracks keys independently and can reset one', () => {
    const { limiter } = setup({ limit: 1 });
    limiter.recordFailure('a');
    expect(limiter.retryAfterMs('a')).toBeGreaterThan(0);
    expect(limiter.retryAfterMs('b')).toBe(0);

    limiter.reset('a');
    expect(limiter.retryAfterMs('a')).toBe(0);
  });

  it('caps the number of tracked keys, dropping expired then oldest entries', () => {
    const { clock, limiter } = setup({ limit: 1, maxKeys: 3 });
    limiter.recordFailure('old');
    clock.advance(11 * MINUTE); // 'old' has expired
    limiter.recordFailure('b');
    limiter.recordFailure('c');
    limiter.recordFailure('d'); // at the cap: the expired entry makes room
    expect(limiter.retryAfterMs('b')).toBeGreaterThan(0);

    limiter.recordFailure('e'); // nothing expired, so the oldest live key ('b') is dropped
    expect(limiter.retryAfterMs('b')).toBe(0);
    expect(limiter.retryAfterMs('e')).toBeGreaterThan(0);
    expect(limiter.retryAfterMs('d')).toBeGreaterThan(0);
  });
});
