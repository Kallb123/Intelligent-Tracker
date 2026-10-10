import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

/**
 * Creates a uniquely named, empty database on the server in `adminUrl` (any database on it,
 * such as `postgres`), so integration tests are isolated and re-runnable.
 */
export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `tracker_test_${randomBytes(6).toString('hex')}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  return {
    url: url.toString(),
    async drop() {
      const conn = postgres(adminUrl, { max: 1, onnotice: () => {} });
      try {
        await conn.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await conn.end({ timeout: 5 });
      }
    },
  };
}
