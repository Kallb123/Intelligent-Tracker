import {
  bankHoliday,
  bankHolidaySync,
  cachedBankHolidays,
  createDb,
  household,
  materialiseTask,
  occurrence,
  runMigrations,
  seedReferenceData,
  task,
  type DbHandle,
} from '@tracker/db';
import { createTestDatabase, type TestDatabase } from '@tracker/db/test-db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshBankHolidays, BANK_HOLIDAY_URL } from './bank-holidays.js';

const adminUrl = process.env['TEST_DATABASE_URL'];
const now = new Date('2026-12-01T12:00Z');
const week = 7 * 86_400_000;
const events = [
  { title: 'Christmas Day', date: '2026-12-25', notes: '', bunting: true },
  { title: 'Boxing Day', date: '2026-12-28', notes: 'Substitute day', bunting: true },
];
const response = () =>
  new Response(JSON.stringify({ 'england-and-wales': { division: 'england-and-wales', events } }));

describe.skipIf(!adminUrl)('bank holiday sync (integration)', () => {
  let testDb: TestDatabase;
  let handle: DbHandle;
  beforeAll(async () => {
    testDb = await createTestDatabase(adminUrl!);
    await runMigrations({ databaseUrl: testDb.url });
    handle = createDb(testDb.url);
  });
  afterAll(async () => {
    await handle?.close();
    await testDb?.drop();
  });
  beforeEach(async () => {
    await handle.sql`truncate household, bank_holiday, bank_holiday_sync cascade`;
  });

  it('validates the England/Wales division, persists it and refreshes weekly across restarts', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    expect(await refreshBankHolidays(handle.db, now, fetcher)).toEqual({
      synced: true,
      failures: [],
    });
    expect(fetcher).toHaveBeenCalledWith(
      BANK_HOLIDAY_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(await cachedBankHolidays(handle.db, 'england-and-wales')).toEqual([
      { region: 'england-and-wales', title: 'Christmas Day', date: '2026-12-25' },
      { region: 'england-and-wales', title: 'Boxing Day (Substitute day)', date: '2026-12-28' },
    ]);
    expect(
      await refreshBankHolidays(handle.db, new Date(now.getTime() + week - 1), fetcher),
    ).toEqual({ synced: false, failures: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await refreshBankHolidays(handle.db, new Date(now.getTime() + week), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps the last good cache on HTTP, malformed, empty, duplicate and network failures', async () => {
    await handle.db
      .insert(bankHoliday)
      .values({ region: 'england-and-wales', date: '2026-12-25', title: 'Cached Christmas' });
    const fetcher = vi.fn<typeof fetch>();
    const failures = [
      () => new Response('', { status: 503 }),
      () => new Response('not json'),
      () => new Response('{}'),
      () =>
        new Response(
          JSON.stringify({ 'england-and-wales': { division: 'england-and-wales', events: [] } }),
        ),
      () =>
        new Response(
          JSON.stringify({
            'england-and-wales': { division: 'england-and-wales', events: [events[0], events[0]] },
          }),
        ),
    ];
    for (const failure of failures) {
      await handle.db.delete(bankHolidaySync);
      fetcher.mockResolvedValueOnce(failure());
      expect(await refreshBankHolidays(handle.db, now, fetcher)).toMatchObject({
        synced: false,
        error: expect.any(String),
      });
      expect(await cachedBankHolidays(handle.db, 'england-and-wales')).toHaveLength(1);
    }
    await handle.db.delete(bankHolidaySync);
    fetcher.mockRejectedValueOnce(new Error('offline'));
    expect(await refreshBankHolidays(handle.db, now, fetcher)).toMatchObject({ error: 'offline' });
    const calls = fetcher.mock.calls.length;
    await refreshBankHolidays(handle.db, new Date(now.getTime() + 60_000), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it('coalesces shifted daily dates, preserves recurrence anchors and rematerialises after sync', async () => {
    const h = (await handle.db.insert(household).values({ name: 'Home' }).returning())[0]!;
    const t = (
      await handle.db
        .insert(task)
        .values({
          householdId: h.id,
          title: 'Work',
          scheduleKind: 'fixed',
          rrule: 'FREQ=DAILY;COUNT=4',
          dueDate: '2026-12-25',
          workingDaysOnly: true,
        })
        .returning()
    )[0]!;
    await materialiseTask(handle.db, t.id, { now });
    await refreshBankHolidays(handle.db, now, async () => response());
    await materialiseTask(handle.db, t.id, { now });
    const rows = await handle.db.select().from(occurrence).where(eq(occurrence.taskId, t.id));
    expect(rows.map((o) => o.dueDate)).toEqual(['2026-12-29']);
    expect((await handle.db.select().from(task).where(eq(task.id, t.id)))[0]?.dueDate).toBe(
      '2026-12-25',
    );
  });
  it('re-plans only the occurrences a changed holiday can move', async () => {
    const h = (await handle.db.insert(household).values({ name: 'Home' }).returning())[0]!;
    const t = (
      await handle.db
        .insert(task)
        .values({
          householdId: h.id,
          title: 'Mondays',
          scheduleKind: 'fixed',
          rrule: 'FREQ=WEEKLY;COUNT=3',
          dueDate: '2026-12-14',
          workingDaysOnly: true,
        })
        .returning()
    )[0]!;
    await materialiseTask(handle.db, t.id, { now });
    const before = await handle.db.select().from(occurrence).where(eq(occurrence.taskId, t.id));
    await refreshBankHolidays(handle.db, now, async () => response());
    const after = await handle.db.select().from(occurrence).where(eq(occurrence.taskId, t.id));
    const idOf = (rows: typeof after, date: string) => rows.find((o) => o.dueDate === date)?.id;
    expect(after.map((o) => o.dueDate).sort()).toEqual(['2026-12-14', '2026-12-21', '2026-12-29']);
    expect(idOf(after, '2026-12-14')).toBe(idOf(before, '2026-12-14'));
    expect(idOf(after, '2026-12-21')).toBe(idOf(before, '2026-12-21'));
  });
  it('does not move a re-planned due into the past when a holiday is withdrawn', async () => {
    await handle.db.insert(bankHoliday).values(
      ['2026-11-27', '2026-11-30'].map((date) => ({
        region: 'england-and-wales' as const,
        date,
        title: 'Cached',
      })),
    );
    const h = (await handle.db.insert(household).values({ name: 'Home' }).returning())[0]!;
    const t = (
      await handle.db
        .insert(task)
        .values({
          householdId: h.id,
          title: 'Once',
          scheduleKind: 'once',
          dueDate: '2026-11-27',
          workingDaysOnly: true,
        })
        .returning()
    )[0]!;
    await materialiseTask(handle.db, t.id, { now: new Date('2026-11-26T12:00Z') });
    await refreshBankHolidays(handle.db, new Date('2026-11-28T12:00Z'), async () => response());
    const rows = await handle.db.select().from(occurrence).where(eq(occurrence.taskId, t.id));
    expect(rows.map((o) => [o.dueDate, o.sourceDueKeys])).toEqual([
      ['2026-11-30', ['d:2026-11-27']],
    ]);
  });
  it('reports a broken task, keeps its occurrences and still finishes the sync', async () => {
    const h = (await handle.db.insert(household).values({ name: 'Home' }).returning())[0]!;
    const [broken, working] = await handle.db
      .insert(task)
      .values(
        ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'].map(
          (id) => ({
            id,
            householdId: h.id,
            title: 'Daily',
            scheduleKind: 'fixed' as const,
            rrule: 'FREQ=DAILY;COUNT=4',
            dueDate: '2026-12-25',
            workingDaysOnly: true,
          }),
        ),
      )
      .returning();
    await materialiseTask(handle.db, broken!.id, { now });
    await materialiseTask(handle.db, working!.id, { now });
    await handle.db.update(task).set({ rrule: 'NOT A RULE' }).where(eq(task.id, broken!.id));
    const kept = await handle.db.select().from(occurrence).where(eq(occurrence.taskId, broken!.id));

    const result = await refreshBankHolidays(handle.db, now, async () => response());
    expect(result).toMatchObject({ synced: true, failures: [{ taskId: broken!.id }] });
    expect(
      await handle.db.select().from(occurrence).where(eq(occurrence.taskId, broken!.id)),
    ).toEqual(kept);
    expect(
      (await handle.db.select().from(occurrence).where(eq(occurrence.taskId, working!.id))).map(
        (o) => o.dueDate,
      ),
    ).toEqual(['2026-12-29']);
    expect((await handle.db.select().from(bankHolidaySync))[0]?.syncedAt).toEqual(now);
  });
  it('keeps a due-today job whose original Sunday is already in the past', async () => {
    const h = (await handle.db.insert(household).values({ name: 'Home' }).returning())[0]!;
    const t = (
      await handle.db
        .insert(task)
        .values({
          householdId: h.id,
          title: 'Weekly',
          scheduleKind: 'fixed',
          rrule: 'FREQ=WEEKLY',
          dueDate: '2026-12-06',
          workingDaysOnly: true,
        })
        .returning()
    )[0]!;
    await materialiseTask(handle.db, t.id, { now });
    await refreshBankHolidays(handle.db, new Date('2026-12-07T12:00Z'), async () => response());
    const rows = await handle.db.select().from(occurrence).where(eq(occurrence.taskId, t.id));
    expect(rows.filter((o) => o.dueDate === '2026-12-07')).toHaveLength(1);
    expect(rows.find((o) => o.dueDate === '2026-12-07')?.sourceDueKeys).toEqual(['d:2026-12-06']);
  });

  it.each(['started', 'done', 'skipped'] as const)(
    'does not recreate a %s instance when a new holiday changes its shifted date',
    async (status) => {
      const h = (await handle.db.insert(household).values({ name: 'Home' }).returning())[0]!;
      const t = (
        await handle.db
          .insert(task)
          .values({
            householdId: h.id,
            title: 'Weekly',
            scheduleKind: 'fixed',
            rrule: 'FREQ=WEEKLY',
            dueDate: '2026-12-06',
            workingDaysOnly: true,
          })
          .returning()
      )[0]!;
      await materialiseTask(handle.db, t.id, { now });
      const first = (
        await handle.db.select().from(occurrence).where(eq(occurrence.dueDate, '2026-12-07'))
      )[0]!;
      await handle.db.update(occurrence).set({ status }).where(eq(occurrence.id, first.id));
      const changed = () =>
        new Response(
          JSON.stringify({
            'england-and-wales': {
              division: 'england-and-wales',
              events: [...events, { title: 'One-off holiday', date: '2026-12-07' }],
            },
          }),
        );
      await refreshBankHolidays(handle.db, now, async () => changed());
      await materialiseTask(handle.db, t.id, { now });
      const rows = await handle.db.select().from(occurrence).where(eq(occurrence.taskId, t.id));
      expect(rows.filter((o) => o.sourceDueKeys.includes('d:2026-12-06'))).toMatchObject([
        { id: first.id, status, dueDate: '2026-12-07' },
      ]);
      expect(rows.some((o) => o.dueDate === '2026-12-08')).toBe(false);
    },
  );

  it('does not let API startup reseed a withdrawn date after successful sync', async () => {
    await seedReferenceData(handle.db);
    await refreshBankHolidays(handle.db, now, async () => response());
    expect(await seedReferenceData(handle.db)).toEqual({ bankHolidays: 0 });
    expect((await cachedBankHolidays(handle.db, 'england-and-wales')).map((h) => h.date)).toEqual(
      events.map((e) => e.date),
    );
  });

  it('serializes a simultaneous offline seed behind an in-flight refresh', async () => {
    let release!: (response: Response) => void;
    let fetched!: () => void;
    const started = new Promise<void>((resolve) => {
      fetched = resolve;
    });
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const syncing = refreshBankHolidays(handle.db, now, async () => {
      fetched();
      return pending;
    });
    await started;
    const seeding = seedReferenceData(handle.db);
    release(response());
    await Promise.all([syncing, seeding]);
    expect((await cachedBankHolidays(handle.db, 'england-and-wales')).map((h) => h.date)).toEqual(
      events.map((e) => e.date),
    );
  });

  it('refreshes withdrawn dates without touching another region', async () => {
    await handle.db.insert(bankHoliday).values([
      { region: 'england-and-wales', date: '2026-12-24', title: 'Withdrawn' },
      { region: 'scotland', date: '2026-11-30', title: 'St Andrew’s Day' },
    ]);
    await refreshBankHolidays(handle.db, now, async () => response());
    expect(
      (await cachedBankHolidays(handle.db, 'england-and-wales')).some(
        (h) => h.date === '2026-12-24',
      ),
    ).toBe(false);
    expect(await cachedBankHolidays(handle.db, 'scotland')).toHaveLength(1);
  });
});
