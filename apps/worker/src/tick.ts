import { activateDue, materialiseAll, type Database, type MaterialiseFailure } from '@tracker/db';
import { sql } from 'drizzle-orm';

/**
 * Key of the Postgres advisory lock held for the duration of a tick, so replicas of the worker
 * never tick at the same time. Distinct from the db package's `MIGRATION_LOCK_KEY`.
 */
export const TICK_LOCK_KEY = 7_452_002;

/** The slice of a logger a tick needs; the worker's JSON logger and pino both fit. */
export interface TickLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export type TickResult =
  /** Another worker holds the tick lock; nothing was done. */
  | { skipped: true }
  | {
      skipped: false;
      /** Tasks looked at (non-archived, in any household). */
      tasks: number;
      /** Occurrences newly materialised. */
      inserted: number;
      /** Occurrences moved from `upcoming` to `active`. */
      activated: number;
      /** Tasks whose schedule could not be materialised; the others were. */
      failures: MaterialiseFailure[];
    };

/**
 * One worker tick: materialises every task's upcoming occurrences, then activates those whose
 * start has arrived. Idempotent, and serialised across workers by a transaction-scoped advisory
 * lock (released on commit or rollback, so a crashed worker cannot leave it held).
 * A task that cannot be materialised is logged and left to the next tick.
 */
export async function runTick(
  db: Database,
  options: { now: Date; logger: TickLogger },
): Promise<TickResult> {
  const { now, logger } = options;
  const result = await db.transaction(async (tx): Promise<TickResult> => {
    const rows = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${TICK_LOCK_KEY}::bigint) as locked`,
    );
    if (!rows[0]?.locked) return { skipped: true };
    const materialised = await materialiseAll(tx, { now });
    const activated = await activateDue(tx, { now });
    return {
      skipped: false,
      tasks: materialised.tasks,
      inserted: materialised.inserted,
      activated,
      failures: materialised.failures,
    };
  });
  if (!result.skipped) {
    for (const failure of result.failures) {
      logger.warn({ ...failure }, 'could not materialise task');
    }
  }
  return result;
}
