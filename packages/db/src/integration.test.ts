import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import { MIGRATION_LOCK_KEY, resolveMigrationsFolder, runMigrations } from './migrate.js';
import {
  bankHoliday,
  household,
  member,
  occurrence,
  passwordToken,
  task,
  taskAssignee,
  taskMilestone,
} from './schema/index.js';
import { seedDemoHousehold, seedReferenceData } from './seed/index.js';
import { createTestDatabase, type TestDatabase } from './test-db.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

/** Runs a query expected to fail and returns the Postgres error (code, constraint) behind it. */
async function pgError(
  query: PromiseLike<unknown>,
): Promise<{ code?: string; constraint_name?: string }> {
  try {
    await query;
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause ?? err;
    return cause as { code?: string; constraint_name?: string };
  }
  throw new Error('expected the query to fail');
}

describe.skipIf(!adminUrl)('database (integration)', () => {
  let testDb: TestDatabase;
  let handle: DbHandle;

  beforeAll(async () => {
    testDb = await createTestDatabase(adminUrl as string);
    await runMigrations({ databaseUrl: testDb.url });
    handle = createDb(testDb.url);
  });

  afterAll(async () => {
    await handle?.close();
    await testDb?.drop();
  });

  const journalLength = (): number => {
    const folder = resolveMigrationsFolder();
    const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
      entries: unknown[];
    };
    return journal.entries.length;
  };

  const appliedMigrations = async (sql: DbHandle['sql']): Promise<number> => {
    const [row] = await sql<
      { n: number }[]
    >`select count(*)::int as n from drizzle.__drizzle_migrations`;
    return row?.n ?? 0;
  };

  async function newHousehold(name = 'Test') {
    const [h] = await handle.db.insert(household).values({ name }).returning();
    if (!h) throw new Error('insert failed');
    return h;
  }

  async function newTask(householdId: string, values: Partial<typeof task.$inferInsert> = {}) {
    const [t] = await handle.db
      .insert(task)
      .values({ householdId, title: 'Bins', scheduleKind: 'fixed', ...values })
      .returning();
    if (!t) throw new Error('insert failed');
    return t;
  }

  describe('migrations', () => {
    it('create every table and enum', async () => {
      const tables = await handle.sql<{ table_name: string }[]>`
        select table_name from information_schema.tables where table_schema = 'public' order by 1`;
      expect(tables.map((t) => t.table_name)).toEqual([
        'activity',
        'bank_holiday',
        'bank_holiday_sync',
        'household',
        'member',
        'notification',
        'occurrence',
        'password_token',
        'push_subscription',
        'quick_add_draft',
        'reminder',
        'service_heartbeat',
        'session',
        'task',
        'task_assignee',
        'task_milestone',
        'telegram_digest',
        'template',
      ]);

      const enums = await handle.sql<{ typname: string }[]>`
        select typname from pg_type where typtype = 'e' order by 1`;
      expect(enums.map((e) => e.typname)).toEqual([
        'assignment_mode',
        'bank_holiday_region',
        'digest_kind',
        'member_role',
        'notification_channel',
        'occurrence_status',
        'password_token_purpose',
        'reminder_kind',
        'reminder_profile',
        'reminder_slot',
        'reminder_status',
        'schedule_kind',
      ]);
      expect(await appliedMigrations(handle.sql)).toBe(journalLength());
    });

    it('are a no-op when run again', async () => {
      const before = await appliedMigrations(handle.sql);
      await runMigrations({ databaseUrl: testDb.url });
      expect(await appliedMigrations(handle.sql)).toBe(before);
    });

    it('apply once when two runners start together', async () => {
      const fresh = await createTestDatabase(adminUrl as string);
      const check = createDb(fresh.url, { max: 1 });
      try {
        await Promise.all([
          runMigrations({ databaseUrl: fresh.url }),
          runMigrations({ databaseUrl: fresh.url }),
        ]);
        expect(await appliedMigrations(check.sql)).toBe(journalLength());
      } finally {
        await check.close();
        await fresh.drop();
      }
    });

    it('wait while another session holds the advisory lock', async () => {
      const fresh = await createTestDatabase(adminUrl as string);
      const holder = createDb(fresh.url, { max: 1 });
      try {
        await holder.sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
        let finished = false;
        const run = runMigrations({ databaseUrl: fresh.url }).then(() => (finished = true));
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(finished).toBe(false);

        await holder.sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`;
        await run;
        expect(finished).toBe(true);
        expect(await appliedMigrations(holder.sql)).toBe(journalLength());
      } finally {
        await holder.close();
        await fresh.drop();
      }
    });
  });

  describe('seed', () => {
    it('seedReferenceData is idempotent', async () => {
      const count = async () => (await handle.db.select().from(bankHoliday)).length;
      await seedReferenceData(handle.db);
      const first = await count();
      await seedReferenceData(handle.db);
      expect(await count()).toBe(first);
    });

    it('seedDemoHousehold creates one household with UK defaults, once', async () => {
      const fresh = await createTestDatabase(adminUrl as string);
      await runMigrations({ databaseUrl: fresh.url });
      const other = createDb(fresh.url, { max: 1 });
      try {
        const created = await seedDemoHousehold(other.db);
        expect(created).toMatchObject({
          name: 'Home',
          timezone: 'Europe/London',
          locale: 'en-GB',
          bankHolidayRegion: 'england-and-wales',
          icalPublicHost: 'calendar.kallum.uk',
          defaultReminderProfile: 'standard',
          morningSlot: '08:00:00',
          eveningSlot: '19:00:00',
          quietHoursStart: '21:30:00',
          quietHoursEnd: '07:30:00',
          telegramGroupChatId: null,
        });
        expect(await seedDemoHousehold(other.db)).toBeNull();
        expect(await other.db.select().from(household)).toHaveLength(1);
      } finally {
        await other.close();
        await fresh.drop();
      }
    });
  });

  describe('constraints', () => {
    it('deleting a household cascades to members, tasks and occurrences', async () => {
      const h = await newHousehold();
      await handle.db
        .insert(member)
        .values({ householdId: h.id, name: 'Sam', username: 'sam-cascade' });
      const t = await newTask(h.id, { dueDate: '2026-11-01' });
      await handle.db.insert(occurrence).values({ taskId: t.id, dueDate: '2026-11-01' });
      await handle.db.insert(taskMilestone).values({
        taskId: t.id,
        title: 'Get quotes',
        offsetDaysBeforeDue: 30,
        position: 0,
      });

      await handle.db.delete(household).where(eq(household.id, h.id));

      expect(await handle.db.select().from(member).where(eq(member.householdId, h.id))).toEqual([]);
      expect(await handle.db.select().from(task).where(eq(task.id, t.id))).toEqual([]);
      expect(await handle.db.select().from(occurrence).where(eq(occurrence.taskId, t.id))).toEqual(
        [],
      );
      expect(
        await handle.db.select().from(taskMilestone).where(eq(taskMilestone.taskId, t.id)),
      ).toEqual([]);
    });

    it('rejects a second occurrence of the same task on the same due date', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id);
      await handle.db.insert(occurrence).values({ taskId: t.id, dueDate: '2026-12-01' });

      const err = await pgError(
        handle.db.insert(occurrence).values({ taskId: t.id, dueDate: '2026-12-01' }),
      );
      expect(err).toMatchObject({ code: '23505', constraint_name: 'occurrence_task_due_date_uq' });

      // A different date is fine.
      await handle.db.insert(occurrence).values({ taskId: t.id, dueDate: '2026-12-02' });
    });

    it('rejects a second occurrence of the same task at the same instant', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, { allDay: false, dueAt: new Date('2026-12-01T19:00:00Z') });
      const dueAt = new Date('2026-12-01T19:00:00Z');
      await handle.db.insert(occurrence).values({ taskId: t.id, dueAt });
      const err = await pgError(handle.db.insert(occurrence).values({ taskId: t.id, dueAt }));
      expect(err).toMatchObject({ code: '23505', constraint_name: 'occurrence_task_due_at_uq' });
    });

    it('allows only one undated occurrence per task', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, { scheduleKind: 'once' });
      await handle.db.insert(occurrence).values({ taskId: t.id });
      const err = await pgError(handle.db.insert(occurrence).values({ taskId: t.id }));
      expect(err).toMatchObject({ code: '23505', constraint_name: 'occurrence_task_undated_uq' });
    });

    it('treats usernames as case-insensitive', async () => {
      const h = await newHousehold();
      await handle.db.insert(member).values({ householdId: h.id, name: 'Sam', username: 'Sam-ci' });
      const err = await pgError(
        handle.db
          .insert(member)
          .values({ householdId: h.id, name: 'Other Sam', username: 'sam-CI' }),
      );
      expect(err).toMatchObject({ code: '23505', constraint_name: 'member_username_lower_uq' });
    });

    it('treats emails as case-insensitive, but allows members without one', async () => {
      const h = await newHousehold();
      await handle.db
        .insert(member)
        .values({ householdId: h.id, name: 'A', username: 'a-email', email: 'Sam@Example.com' });
      const err = await pgError(
        handle.db
          .insert(member)
          .values({ householdId: h.id, name: 'B', username: 'b-email', email: 'sam@example.com' }),
      );
      expect(err).toMatchObject({ code: '23505', constraint_name: 'member_email_lower_uq' });

      await handle.db.insert(member).values([
        { householdId: h.id, name: 'C', username: 'c-email' },
        { householdId: h.id, name: 'D', username: 'd-email' },
      ]);
    });

    it('deletes password tokens with their member', async () => {
      const h = await newHousehold();
      const [m] = await handle.db
        .insert(member)
        .values({ householdId: h.id, name: 'Sam', username: 'sam-token' })
        .returning();
      await handle.db.insert(passwordToken).values({
        id: 'hash-of-token',
        memberId: (m as { id: string }).id,
        purpose: 'invite',
        expiresAt: new Date(Date.now() + 1000),
      });

      await handle.db.delete(member).where(eq(member.id, (m as { id: string }).id));
      expect(await handle.db.select().from(passwordToken)).toEqual([]);
    });

    it('gives each member a generated iCal token and an empty reminder-times list', async () => {
      const h = await newHousehold();
      const [a, b] = await handle.db
        .insert(member)
        .values([
          { householdId: h.id, name: 'A', username: 'a-token' },
          { householdId: h.id, name: 'B', username: 'b-token' },
        ])
        .returning();
      expect(a?.icalToken).toHaveLength(32);
      expect(a?.icalToken).not.toBe(b?.icalToken);
      expect(a?.preferredReminderTimes).toEqual([]);
      expect(a?.role).toBe('member');
    });

    it('stores Telegram chat ids beyond int32', async () => {
      const [h] = await handle.db
        .insert(household)
        .values({ name: 'Telegram', telegramGroupChatId: -1_001_234_567_890 })
        .returning();
      expect(h?.telegramGroupChatId).toBe(-1_001_234_567_890);
    });

    it.each([
      [
        'an after-completion task with no interval',
        { scheduleKind: 'after_completion' as const },
        'task_after_completion_interval',
      ],
      ['a non-positive interval', { intervalAfterCompletionDays: 0 }, 'task_interval_positive'],
      ['a negative lead time', { leadTimeDays: -1 }, 'task_lead_time_non_negative'],
      [
        'a timed task flagged all-day',
        { dueAt: new Date('2026-12-01T09:00:00Z') },
        'task_all_day_matches_due_at',
      ],
      [
        'a custom-time slot without a time',
        { reminderSlot: 'custom_time' as const },
        'task_custom_time_set',
      ],
    ])('rejects %s', async (_label, values, constraint) => {
      const h = await newHousehold();
      const err = await pgError(
        handle.db
          .insert(task)
          .values({ householdId: h.id, title: 'Bad', scheduleKind: 'fixed', ...values }),
      );
      expect(err).toMatchObject({ code: '23514', constraint_name: constraint });
    });

    it('rejects an occurrence with both a due date and a due instant', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id);
      const err = await pgError(
        handle.db
          .insert(occurrence)
          .values({ taskId: t.id, dueDate: '2026-12-01', dueAt: new Date() }),
      );
      expect(err).toMatchObject({ code: '23514', constraint_name: 'occurrence_single_due' });
    });

    it('keeps task assignees and milestones ordered and unique per task', async () => {
      const h = await newHousehold();
      const [m1, m2] = await handle.db
        .insert(member)
        .values([
          { householdId: h.id, name: 'M1', username: 'm1-order' },
          { householdId: h.id, name: 'M2', username: 'm2-order' },
        ])
        .returning();
      const t = await newTask(h.id);
      await handle.db.insert(taskAssignee).values({ taskId: t.id, memberId: m1!.id, position: 0 });

      const samePosition = await pgError(
        handle.db.insert(taskAssignee).values({ taskId: t.id, memberId: m2!.id, position: 0 }),
      );
      expect(samePosition).toMatchObject({
        code: '23505',
        constraint_name: 'task_assignee_task_position_uq',
      });
      const sameMember = await pgError(
        handle.db.insert(taskAssignee).values({ taskId: t.id, memberId: m1!.id, position: 1 }),
      );
      expect(sameMember).toMatchObject({ code: '23505' });

      // Deleting the member removes them from the rotation.
      await handle.db.delete(member).where(eq(member.id, m1!.id));
      expect(
        await handle.db.select().from(taskAssignee).where(eq(taskAssignee.taskId, t.id)),
      ).toEqual([]);
    });
  });
});
