import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  /** Drizzle instance with the full schema attached. */
  db: Database;
  /** The underlying postgres.js client, for raw SQL. */
  sql: postgres.Sql;
  /** Ends the connection pool, waiting briefly for in-flight queries. */
  close(): Promise<void>;
}

/** Connects to Postgres. NOTICE messages (such as "already exists, skipping") are silenced. */
export function createDb(
  url: string,
  options: postgres.Options<Record<string, never>> = {},
): DbHandle {
  const sql = postgres(url, { onnotice: () => {}, ...options });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
