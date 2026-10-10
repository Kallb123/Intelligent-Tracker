import { runMigrations } from '../migrate.js';
import { requireDatabaseUrl } from './env.js';

// Applies pending migrations. Usage: DATABASE_URL=... pnpm db:migrate
await runMigrations({ databaseUrl: requireDatabaseUrl(), logger: console });
