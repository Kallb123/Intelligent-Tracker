import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTicker } from './ticker.js';

describe('startTicker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs immediately, then again an interval after each run finishes', async () => {
    const run = vi.fn(async () => {});
    const ticker = startTicker({ run, intervalMs: 1000, onError: () => {} });
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
    await ticker.stop();
  });

  it('never overlaps runs, however long one takes', async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const run = async (): Promise<void> => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      active--;
    };
    const ticker = startTicker({ run, intervalMs: 1000, onError: () => {} });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBeGreaterThan(1);
    expect(maxActive).toBe(1);
    // Stop waits for the run still in flight, which needs its fake timer advanced.
    const stopping = ticker.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    expect(active).toBe(0);
  });

  it('reports errors and keeps ticking', async () => {
    const onError = vi.fn();
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    const ticker = startTicker({ run, intervalMs: 1000, onError });
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    await ticker.stop();
  });

  it('stop waits for the in-flight run and schedules nothing after it', async () => {
    let finish: () => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const ticker = startTicker({ run, intervalMs: 1000, onError: () => {} });
    let stopped = false;
    const stopping = ticker.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop between runs cancels the pending timer', async () => {
    const run = vi.fn(async () => {});
    const ticker = startTicker({ run, intervalMs: 1000, onError: () => {} });
    await vi.advanceTimersByTimeAsync(10);
    await ticker.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
