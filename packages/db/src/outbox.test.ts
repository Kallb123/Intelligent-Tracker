import { describe, expect, it } from 'vitest';
import { OUTBOX_RETRY_BASE_MS, OUTBOX_RETRY_MAX_MS, outboxBackoffMs } from './outbox.js';

describe('outboxBackoffMs', () => {
  it('waits 30 seconds after the first failure and doubles each time', () => {
    expect([1, 2, 3, 4, 5].map(outboxBackoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000,
    ]);
    expect(outboxBackoffMs(1)).toBe(OUTBOX_RETRY_BASE_MS);
  });

  it('is capped at an hour', () => {
    expect(outboxBackoffMs(8)).toBe(OUTBOX_RETRY_MAX_MS);
    expect(outboxBackoffMs(500)).toBe(OUTBOX_RETRY_MAX_MS);
  });

  it('treats a count below one as the first failure', () => {
    expect(outboxBackoffMs(0)).toBe(OUTBOX_RETRY_BASE_MS);
  });
});
