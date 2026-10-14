import type { DbOrTransaction } from './client.js';
import { serviceHeartbeat } from './schema/index.js';

/** The `service_heartbeat` row the worker touches every tick; `/api/health` reports on it. */
export const WORKER_SERVICE = 'worker';

/** Records that `service` is alive at `now` (one row per service, created on first use). */
export async function recordHeartbeat(
  db: DbOrTransaction,
  service: string,
  now: Date,
): Promise<void> {
  await db
    .insert(serviceHeartbeat)
    .values({ service, beatAt: now })
    .onConflictDoUpdate({ target: serviceHeartbeat.service, set: { beatAt: now } });
}
