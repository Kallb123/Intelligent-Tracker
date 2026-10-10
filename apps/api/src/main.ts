import { prepareDatabase } from './database.js';
import { buildServer, startupMessage } from './index.js';

const host = process.env['HOST'] ?? '0.0.0.0';
const port = Number(process.env['PORT'] ?? 3000);

const app = buildServer({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

try {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl) {
    await prepareDatabase(databaseUrl, app.log);
  } else {
    app.log.warn('DATABASE_URL is not set; skipping migrations');
  }
  app.log.info(startupMessage());
  await app.listen({ host, port });
} catch (err) {
  app.log.error(err, 'failed to start');
  process.exit(1);
}
