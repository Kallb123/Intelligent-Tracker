import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Key of the Postgres advisory lock held while migrating, so concurrent starts (api replicas,
 * `pnpm db:migrate` during a deploy) apply migrations one at a time.
 */
export const MIGRATION_LOCK_KEY = 7_452_001;

export interface MigrationLogger {
  info(message: string): void;
}

export interface RunMigrationsOptions {
  databaseUrl: string;
  /** Folder holding the drizzle-kit output. Defaults to `MIGRATIONS_DIR`, then this package's. */
  migrationsFolder?: string;
  logger?: MigrationLogger;
}

/**
 * Resolves the migrations folder: explicit option, then `MIGRATIONS_DIR`, then
 * `packages/db/migrations`. The default is relative to this file, which only works from
 * source; the esbuild bundle (used in Docker) must set `MIGRATIONS_DIR`.
 */
export function resolveMigrationsFolder(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    explicit || env['MIGRATIONS_DIR'] || fileURLToPath(new URL('../migrations', import.meta.url))
  );
}

/** Applies pending migrations while holding an advisory lock. Safe to call concurrently. */
export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  const folder = resolveMigrationsFolder(options.migrationsFolder);
  // One connection, so the session-level advisory lock and the migrations share a session.
  const sql = postgres(options.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    options.logger?.info(`running migrations from ${folder}`);
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
    try {
      await migrate(drizzle(sql), { migrationsFolder: folder });
    } finally {
      // Best effort: closing the connection below releases the lock anyway.
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`.catch(() => undefined);
    }
    options.logger?.info('migrations up to date');
  } finally {
    await sql.end({ timeout: 5 });
  }
}
