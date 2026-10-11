import { createDb, household, occurrence, runMigrations, task, type DbHandle } from '@tracker/db';
import { createTestDatabase, type TestDatabase } from '@tracker/db/test-db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TICK_LOCK_KEY, runTick } from './tick.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

const at = (iso: string): Date => new Date(iso);

describe.skipIf(!adminUrl)('worker tick (integration)', () => {
  let testDb: TestDatabase;
  let handle: DbHandle;
  const logger = { warn: vi.fn() };

  beforeAll(async () => {
    testDb = await createTestDatabase(adminUrl as string);
    await runMigrations({ databaseUrl: testDb.url });
    handle = createDb(testDb.url);
  });

  afterAll(async () => {
    await handle?.close();
    await testDb?.drop();
  });

  // Every test starts from an empty database (the household delete cascades to everything).
  beforeEach(async () => {
    logger.warn.mockClear();
    await handle.db.delete(household);
  });

  async function newTask(values: Partial<typeof task.$inferInsert> = {}) {
    const [h] = await handle.db.insert(household).values({ name: 'Test' }).returning();
    if (!h) throw new Error('insert failed');
    const [t] = await handle.db
      .insert(task)
      .values({
        householdId: h.id,
        title: 'Bins',
        scheduleKind: 'fixed',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        dueDate: '2026-07-06',
        ...values,
      })
      .returning();
    if (!t) throw new Error('insert failed');
    return t;
  }

  const occurrences = () => handle.db.select().from(occurrence);

  it('materialises occurrences and activates the ones that are due', async () => {
    await newTask();

    const result = await runTick(handle.db, { now: at('2026-07-06T09:00:00Z'), logger });

    expect(result).toEqual({
      skipped: false,
      tasks: 1,
      inserted: 13,
      activated: 0,
      failures: [],
    });
    const rows = await occurrences();
    expect(rows).toHaveLength(13);
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
  });

  it('is idempotent: a second tick inserts nothing and changes no rows', async () => {
    await newTask();
    const now = at('2026-07-06T09:00:00Z');
    await runTick(handle.db, { now, logger });
    const before = await occurrences();

    const again = await runTick(handle.db, { now, logger });

    expect(again).toEqual({ skipped: false, tasks: 1, inserted: 0, activated: 0, failures: [] });
    expect(await occurrences()).toEqual(before);
  });

  it('activates upcoming occurrences once their day arrives', async () => {
    await newTask();
    await runTick(handle.db, { now: at('2026-07-06T09:00:00Z'), logger });

    // A week later: the 13 July occurrence is due, and the horizon has moved on by one.
    const result = await runTick(handle.db, { now: at('2026-07-13T09:00:00Z'), logger });

    expect(result).toMatchObject({ skipped: false, inserted: 1, activated: 1 });
    const open = await handle.db.select().from(occurrence).where(eq(occurrence.status, 'active'));
    expect(open.map((r) => r.dueDate).sort()).toEqual(['2026-07-06', '2026-07-13']);
  });

  it('does not duplicate rows when two ticks run at once', async () => {
    await newTask();
    const now = at('2026-07-06T09:00:00Z');

    const results = await Promise.all([
      runTick(handle.db, { now, logger }),
      runTick(handle.db, { now, logger }),
    ]);

    // Either the second waited for nothing (skipped) or ran after the first (inserted 0).
    const inserted = results.reduce((sum, r) => sum + (r.skipped ? 0 : r.inserted), 0);
    expect(inserted).toBe(13);
    expect(await occurrences()).toHaveLength(13);
  });

  it('skips the tick while another worker holds the lock', async () => {
    await newTask();
    const now = at('2026-07-06T09:00:00Z');

    // Hold the lock from a separate session, as another worker mid-tick would.
    let release: () => void = () => {};
    let held: () => void = () => {};
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = handle.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${TICK_LOCK_KEY}::bigint)`;
      held();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await holding;
    try {
      expect(await runTick(handle.db, { now, logger })).toEqual({ skipped: true });
      expect(await occurrences()).toHaveLength(0);
    } finally {
      release();
      await holder;
    }

    // Once the lock is free the next tick does the work.
    expect(await runTick(handle.db, { now, logger })).toMatchObject({ skipped: false });
    expect(await occurrences()).toHaveLength(13);
  });

  it('logs a task that cannot be materialised and still handles the others', async () => {
    const broken = await newTask({ title: 'Broken', rrule: 'NOT-AN-RRULE' });
    await newTask({ title: 'Fine' });

    const result = await runTick(handle.db, { now: at('2026-07-06T09:00:00Z'), logger });

    expect(result).toMatchObject({ skipped: false, tasks: 2, inserted: 13 });
    if (result.skipped) throw new Error('unreachable');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ taskId: broken.id });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: broken.id }),
      'could not materialise task',
    );
  });

  it('releases the lock after a tick', async () => {
    await newTask();
    await runTick(handle.db, { now: at('2026-07-06T09:00:00Z'), logger });

    const rows = await handle.sql`
      select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${TICK_LOCK_KEY}`;
    expect(rows[0]?.['n']).toBe(0);
  });
});
