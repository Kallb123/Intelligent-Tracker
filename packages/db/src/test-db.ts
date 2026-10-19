import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { MS_PER_DAY } from '@tracker/shared';
import type { Database } from './client.js';
import { activity, occurrence } from './schema/index.js';

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

/** Shared synthetic completion/activity history for suggestion API and Telegram tests. */
export async function seedSuggestionHistory(
  db: Database,
  input: {
    householdId: string;
    taskId: string;
    memberId: string;
    dates: string[];
    snoozes?: number;
  },
): Promise<void> {
  for (const date of input.dates) {
    const completedAt = new Date(`${date}T12:00:00Z`);
    const dueDate = new Date(completedAt.getTime() - 4 * MS_PER_DAY).toISOString().slice(0, 10);
    const [row] = await db
      .insert(occurrence)
      .values({
        taskId: input.taskId,
        dueDate,
        status: 'done',
        completedAt,
        completedBy: input.memberId,
      })
      .returning();
    const base = {
      householdId: input.householdId,
      taskId: input.taskId,
      memberId: input.memberId,
      occurrenceId: row!.id,
      createdAt: completedAt,
    };
    await db.insert(activity).values([
      { ...base, kind: 'occurrence.completed' },
      ...Array.from({ length: input.snoozes ?? 2 }, () => ({
        ...base,
        kind: 'occurrence.snoozed',
      })),
    ]);
  }
}
