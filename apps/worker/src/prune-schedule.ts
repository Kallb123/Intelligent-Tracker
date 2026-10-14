/**
 * How often the worker deletes old notifications. The sweep filters on columns without an index,
 * so it is not worth running every tick; retention is measured in days.
 */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface PruneSchedule {
  /** Whether the next tick should prune: never pruned yet, or the last sweep was long enough ago. */
  due(now: Date): boolean;
  /** Records that a sweep ran at `now`. */
  done(now: Date): void;
}

/** Remembers when the notifications were last pruned, so ticks can prune at most once per interval. */
export function createPruneSchedule(intervalMs: number = PRUNE_INTERVAL_MS): PruneSchedule {
  let lastPrunedAt: number | undefined;
  return {
    due: (now) => lastPrunedAt === undefined || now.getTime() - lastPrunedAt >= intervalMs,
    done: (now) => {
      lastPrunedAt = now.getTime();
    },
  };
}
