import {
  activateDue,
  createWebPushHandler,
  deliverOutbox,
  giveUpStaleNotifications,
  materialiseAll,
  pruneDigests,
  pruneNotifications,
  queueDueReminders,
  recordHeartbeat,
  replanReminders,
  WORKER_SERVICE,
  type Database,
  type MaterialiseFailure,
  type OutboxHandler,
  type PushSender,
  type ReminderPlanFailure,
} from '@tracker/db';
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
      /** Due reminders queued in the outbox (and marked sent). */
      queued: number;
      /** Reminder rows inserted or changed by the re-plan. */
      planned: number;
      /** Reminders cancelled: stale ones that were never sent, and ones no longer wanted. */
      cancelled: number;
      /** Occurrences whose reminders could not be planned; the others were. */
      planFailures: ReminderPlanFailure[];
      /** Outbox notifications delivered after the transaction committed. */
      delivered: number;
      /** Old notifications and digest log rows deleted by the retention sweep. */
      pruned: number;
    };

/** An occurrence the planner rejects fails in both the queue check and the re-plan: report it once. */
function uniqueFailures(failures: ReminderPlanFailure[]): ReminderPlanFailure[] {
  return [...new Map(failures.map((f) => [f.occurrenceId, f])).values()];
}

/**
 * How each outbox channel is delivered. An in-app notification is the outbox row itself, so
 * delivering it only stamps `sent_at` (which makes it show up in the member's bell). The
 * `telegram_group` channel has no handler here: the bot owns it, so the worker never claims it.
 * `web_push` is delivered only when the tick is given a `webPush` sender (the server has VAPID
 * keys); otherwise the worker does not claim those rows either.
 */
function handlersFor(
  db: Database,
  now: Date,
  webPush: PushSender | undefined,
  logger: TickLogger,
): Partial<Record<'in_app' | 'web_push', OutboxHandler>> {
  return {
    in_app: async () => {},
    ...(webPush
      ? {
          web_push: createWebPushHandler(db, {
            send: webPush,
            now,
            // Delivered to some of the member's browsers: not retried, so say what failed.
            onPartialFailure: (failure) =>
              logger.warn({ ...failure }, 'push not accepted by some browsers of a member'),
          }),
        }
      : {}),
  };
}

/**
 * One worker tick. Inside a single transaction, serialised across workers by a transaction-scoped
 * advisory lock (released on commit or rollback, so a crashed worker cannot leave it held):
 *
 *   1. materialise every task's upcoming occurrences,
 *   2. activate those whose start has arrived,
 *   3. queue the reminders that are due in the outbox,
 *   4. re-plan the reminders of every open occurrence.
 *
 * Queuing and marking the reminders sent commit together, so a crash loses and duplicates
 * nothing. After the commit the tick records the worker's heartbeat and delivers the outbox
 * (a separate step: delivery is retried with backoff and must not hold the tick lock), then,
 * when `prune` is set (the default), deletes notifications past their retention
 * (`pruneNotifications` and `pruneDigests`; the worker passes `prune` about once an hour, see `PruneSchedule`). The
 * heartbeat is also recorded when another worker holds the lock.
 * With a `webPush` sender, the tick also queues a `web_push` notification for each recipient
 * who has a push subscription, gives up the stale ones and delivers them to the browsers.
 * Idempotent. A task that cannot be materialised, or an occurrence that cannot be planned, is
 * logged and left to the next tick.
 */
export async function runTick(
  db: Database,
  options: {
    now: Date;
    logger: TickLogger;
    /** Run the retention sweep after delivering. Defaults to true. */
    prune?: boolean;
    /** Deliver Web Push through this sender. Without it, push is off and `web_push` is untouched. */
    webPush?: PushSender;
  },
): Promise<TickResult> {
  const { now, logger, prune = true, webPush } = options;
  const result = await db.transaction(async (tx): Promise<TickResult> => {
    const rows = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${TICK_LOCK_KEY}::bigint) as locked`,
    );
    if (!rows[0]?.locked) return { skipped: true };
    const materialised = await materialiseAll(tx, { now });
    const activated = await activateDue(tx, { now });
    const queued = await queueDueReminders(tx, { now, webPush: webPush !== undefined });
    const replanned = await replanReminders(tx, { now });
    return {
      skipped: false,
      tasks: materialised.tasks,
      inserted: materialised.inserted,
      activated,
      failures: materialised.failures,
      queued: queued.queued,
      planned: replanned.planned,
      cancelled: queued.cancelled + replanned.cancelled,
      planFailures: uniqueFailures([...queued.failures, ...replanned.failures]),
      delivered: 0,
      pruned: 0,
    };
  });
  await recordHeartbeat(db, WORKER_SERVICE, now);
  if (result.skipped) return result;

  for (const failure of result.failures) {
    logger.warn({ ...failure }, 'could not materialise task');
  }
  for (const failure of result.planFailures) {
    logger.warn({ ...failure }, 'could not plan reminders');
  }
  // A push left over from a long outage is not worth waking a phone for (as for Telegram).
  if (webPush) {
    const stale = await giveUpStaleNotifications(db, { now, channel: 'web_push' });
    if (stale > 0) logger.warn({ count: stale }, 'stale push notifications not sent');
  }
  const delivery = await deliverOutbox(db, {
    now,
    handlers: handlersFor(db, now, webPush, logger),
  });
  for (const failure of delivery.failures) {
    logger.warn(
      { ...failure },
      failure.gaveUp ? 'gave up delivering notification' : 'could not deliver notification',
    );
  }
  // Retention sweep, last: it never touches pending rows, so it cannot take away what was just
  // queued or delivered.
  const pruned = prune
    ? (await pruneNotifications(db, { now })) + (await pruneDigests(db, { now }))
    : 0;
  return { ...result, delivered: delivery.delivered, pruned };
}
