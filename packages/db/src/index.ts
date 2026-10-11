export { createDb, type Database, type DbHandle, type DbOrTransaction } from './client.js';
export {
  activateDue,
  clearFutureOpenOccurrences,
  materialiseAll,
  materialiseTask,
  reassignOpenOccurrences,
  type MaterialiseAllResult,
  type MaterialiseFailure,
  type MaterialiseTaskResult,
} from './materialise.js';
export {
  MIGRATION_LOCK_KEY,
  resolveMigrationsFolder,
  runMigrations,
  type MigrationLogger,
  type RunMigrationsOptions,
} from './migrate.js';
export * as schema from './schema/index.js';
export * from './schema/index.js';
export * from './seed/index.js';
