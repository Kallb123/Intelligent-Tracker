import { writeFileSync } from 'node:fs';
import { APP_NAME, startupMessage } from './index.js';

const HEARTBEAT_MS = 60_000;
const heartbeatFile = process.env['HEARTBEAT_FILE'];

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ level: 'info', time: Date.now(), service: APP_NAME, msg, ...extra }),
  );
}

/** Touches HEARTBEAT_FILE (when set) so the container healthcheck can tell the loop is alive. */
function beat(): void {
  if (heartbeatFile) writeFileSync(heartbeatFile, new Date().toISOString());
}

log(startupMessage());
if (!process.env['TELEGRAM_BOT_TOKEN']) log('TELEGRAM_BOT_TOKEN is not set; idling');

beat();
const timer = setInterval(() => {
  beat();
  log('heartbeat');
}, HEARTBEAT_MS);

function shutdown(signal: NodeJS.Signals): void {
  log('shutting down', { signal });
  clearInterval(timer);
  process.exit(0);
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
