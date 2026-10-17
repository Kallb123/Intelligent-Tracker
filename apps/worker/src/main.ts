import { createDb } from '@tracker/db';
import { startTicker } from '@tracker/shared';
import { writeFileSync } from 'node:fs';
import { APP_NAME, startupMessage } from './index.js';
import { refreshBankHolidays } from './bank-holidays.js';
import { createPruneSchedule } from './prune-schedule.js';
import { runTick } from './tick.js';

const HEARTBEAT_MS = 60_000;
const heartbeatFile = process.env['HEARTBEAT_FILE'];
const databaseUrl = process.env['DATABASE_URL'];
const tickIntervalMs = Number(process.env['TICK_INTERVAL_MS']) || 60_000;

type Level = 'info' | 'warn' | 'error';

function write(level: Level, msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, time: Date.now(), service: APP_NAME, msg, ...extra }));
}
const log = (msg: string, extra?: Record<string, unknown>): void => write('info', msg, extra);

/** Drizzle wraps driver errors ("Failed query: ..."); the `cause` says what Postgres objected to. */
function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error };
  const { cause } = error;
  return { error: error.message, ...(cause instanceof Error ? { cause: cause.message } : {}) };
}

/** Touches HEARTBEAT_FILE (when set) so the container healthcheck can tell the loop is alive. */
function beat(): void {
  if (heartbeatFile) writeFileSync(heartbeatFile, new Date().toISOString());
}

log(startupMessage());
beat();
const heartbeat = setInterval(() => {
  beat();
  log('heartbeat');
}, HEARTBEAT_MS);

// postgres.js connects lazily, so creating the pool before the api has migrated is safe.
const dbHandle = databaseUrl ? createDb(databaseUrl) : undefined;
const pruning = createPruneSchedule();
const ticker = dbHandle
  ? startTicker({
      intervalMs: tickIntervalMs,
      // A failed tick (e.g. migrations not applied yet) is logged and retried on the next one.
      onError: (error) => write('error', 'tick failed', errorFields(error)),
      run: async () => {
        const now = new Date();
        try {
          const sync = await refreshBankHolidays(dbHandle.db, now);
          if (sync.error)
            write('warn', 'bank holiday sync failed; using cached data', { error: sync.error });
          for (const failure of sync.failures)
            write('warn', 'bank holiday re-plan skipped a task', { ...failure });
        } catch (error) {
          write('warn', 'bank holiday sync failed', errorFields(error));
        }
        const prune = pruning.due(now);
        const result = await runTick(dbHandle.db, {
          now,
          prune,
          logger: { warn: (fields, msg) => write('warn', msg, fields) },
        });
        if (prune && !result.skipped) pruning.done(now);
        if (result.skipped) log('tick skipped; another worker holds the lock');
        else {
          const {
            tasks,
            inserted,
            activated,
            failures,
            queued,
            planned,
            cancelled,
            delivered,
            pruned,
          } = result;
          log('tick', {
            tasks,
            inserted,
            activated,
            failed: failures.length,
            queued,
            planned,
            cancelled,
            planFailed: result.planFailures.length,
            delivered,
            pruned,
          });
        }
      },
    })
  : undefined;
if (!ticker) write('warn', 'DATABASE_URL is not set; only sending heartbeats');

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  log('shutting down', { signal });
  clearInterval(heartbeat);
  await ticker?.stop();
  await dbHandle?.close();
  process.exit(0);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));
