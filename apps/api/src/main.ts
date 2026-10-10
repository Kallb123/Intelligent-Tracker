import { createDb } from '@tracker/db';
import { configFromEnv } from './config.js';
import { prepareDatabase } from './database.js';
import { buildServer, startupMessage } from './index.js';
import { loggerOptions } from './logging.js';

const host = process.env['HOST'] ?? '0.0.0.0';
const port = Number(process.env['PORT'] ?? 3000);
const databaseUrl = process.env['DATABASE_URL'];
const config = configFromEnv(process.env);

// postgres.js connects lazily, so creating the pool before the migrations have run is safe.
const dbHandle = databaseUrl ? createDb(databaseUrl) : undefined;

const app = buildServer({
  logger: loggerOptions(process.env['LOG_LEVEL'] ?? 'info'),
  trustProxy: config.trustProxy,
  auth: config.auth,
  ...(dbHandle ? { db: dbHandle.db } : {}),
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await dbHandle?.close();
  process.exit(0);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

try {
  if (databaseUrl) {
    await prepareDatabase(databaseUrl, app.log);
  } else {
    app.log.warn('DATABASE_URL is not set; skipping migrations and serving only /api/health');
  }
  app.log.info(startupMessage());
  await app.listen({ host, port });
} catch (err) {
  app.log.error(err, 'failed to start');
  process.exit(1);
}
