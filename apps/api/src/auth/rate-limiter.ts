interface Entry {
  failures: number;
  /** When the window that started with the first failure ends. */
  resetAt: number;
}

export interface FailureLimiterOptions {
  /** Failures allowed per window; the next attempt is blocked. */
  limit: number;
  windowMs: number;
  clock: () => Date;
  /** Cap on tracked keys, so attackers cannot grow memory by inventing usernames. */
  maxKeys?: number;
}

/**
 * Counts failures per key in a fixed window that starts at the first failure. In memory only:
 * fine for the single api instance of a home server (a restart just forgives everyone).
 */
export class FailureLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxKeys: number;

  constructor(private readonly options: FailureLimiterOptions) {
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  /** Milliseconds until `key` may try again, or 0 if it is not blocked. */
  retryAfterMs(key: string): number {
    const entry = this.live(key);
    return entry && entry.failures >= this.options.limit ? entry.resetAt - this.now() : 0;
  }

  recordFailure(key: string): void {
    const entry = this.live(key);
    if (entry) {
      entry.failures += 1;
      return;
    }
    if (this.entries.size >= this.maxKeys) this.evict();
    this.entries.set(key, { failures: 1, resetAt: this.now() + this.options.windowMs });
  }

  /** Forgets a key, e.g. after a successful login. */
  reset(key: string): void {
    this.entries.delete(key);
  }

  private now(): number {
    return this.options.clock().getTime();
  }

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.resetAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Drops expired entries and, if that is not enough, the oldest ones. */
  private evict(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxKeys) break;
      this.entries.delete(key);
    }
  }
}
