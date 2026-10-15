import { createDb } from '@tracker/db';
import { startTicker } from '@tracker/shared';
import { writeFileSync } from 'node:fs';
import { BOT_ALLOWED_UPDATES, botDeps, createBot } from './bot.js';
import { configFromEnv } from './config.js';
import { deliverGroupMessages } from './delivery.js';
import { startupMessage } from './index.js';
import { createLogger, errorFields } from './logger.js';

const HEARTBEAT_MS = 60_000;
const config = configFromEnv(process.env);
const logger = createLogger();

/** Touches the heartbeat file (when set) so the container healthcheck can tell the process is alive. */
function beat(): void {
  if (config.heartbeatFile) writeFileSync(config.heartbeatFile, new Date().toISOString());
}

logger.info(startupMessage());
beat();
const heartbeat = setInterval(() => {
  beat();
  logger.info('heartbeat');
}, HEARTBEAT_MS);

// postgres.js connects lazily, so creating the pool before the api has migrated is safe.
const dbHandle = config.databaseUrl ? createDb(config.databaseUrl) : undefined;
const { token } = config;
const botOptions = { logger, publicBaseUrl: config.publicBaseUrl };
const bot = dbHandle && token ? createBot(dbHandle.db, { token, ...botOptions }) : undefined;
if (!token) logger.info('TELEGRAM_BOT_TOKEN is not set; idling');
else if (!dbHandle) logger.warn('DATABASE_URL is not set; idling');

let delivery: ReturnType<typeof startTicker> | undefined;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info('shutting down', { signal });
  clearInterval(heartbeat);
  await bot?.stop();
  await delivery?.stop();
  await dbHandle?.close();
  process.exit(0);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

if (bot && dbHandle) {
  try {
    // Asks Telegram who the bot is; a wrong token fails here, loudly, instead of silently idling.
    await bot.init();
  } catch (error) {
    logger.error('could not reach Telegram; is TELEGRAM_BOT_TOKEN right?', errorFields(error));
    process.exit(1);
  }
  logger.info('bot started', { username: bot.botInfo.username });
  const deps = botDeps(dbHandle.db, botOptions);
  const { db } = dbHandle;
  delivery = startTicker({
    intervalMs: config.deliveryIntervalMs,
    // A failed run (e.g. migrations not applied yet) is logged and retried on the next one.
    onError: (error) => logger.error('delivery run failed', errorFields(error)),
    run: async () => void (await deliverGroupMessages(db, bot.api, deps)),
  });
  // Long polling. Updates that arrived while the bot was down are kept (not dropped), so a
  // button pressed during a restart is still handled. Resolves when `bot.stop()` is called.
  bot.start({ allowed_updates: [...BOT_ALLOWED_UPDATES] }).catch((error: unknown) => {
    logger.error('polling stopped', errorFields(error));
    process.exit(1);
  });
}
