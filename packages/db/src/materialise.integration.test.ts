import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import {
  activateDue,
  clearFutureOpenOccurrences,
  materialiseAll,
  materialiseTask,
  reassignOpenOccurrences,
} from './materialise.js';
import { runMigrations } from './migrate.js';
import {
  household,
  member,
  occurrence,
  task,
  taskAssignee,
  type NewOccurrence,
  type NewTask,
} from './schema/index.js';
import { createTestDatabase, type TestDatabase } from './test-db.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

const at = (iso: string): Date => new Date(iso);

describe.skipIf(!adminUrl)('materialisation (integration)', () => {
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

  // Every test starts from an empty database (the household delete cascades to everything).
  beforeEach(async () => {
    await handle.db.delete(household);
  });

  async function newHousehold(timezone?: string) {
    const [h] = await handle.db
      .insert(household)
      .values({ name: 'Test', ...(timezone ? { timezone } : {}) })
      .returning();
    if (!h) throw new Error('insert failed');
    return h;
  }

  async function newMember(householdId: string, username: string) {
    const [m] = await handle.db
      .insert(member)
      .values({ householdId, name: username, username })
      .returning();
    if (!m) throw new Error('insert failed');
    return m;
  }

  async function newTask(householdId: string, values: Partial<NewTask> = {}) {
    const [t] = await handle.db
      .insert(task)
      .values({
        householdId,
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

  const occurrencesOf = (taskId: string) =>
    handle.db
      .select()
      .from(occurrence)
      .where(eq(occurrence.taskId, taskId))
      .orderBy(asc(occurrence.dueDate), asc(occurrence.dueAt));

  async function insertOccurrence(taskId: string, values: Partial<NewOccurrence>) {
    await handle.db.insert(occurrence).values({ taskId, ...values });
  }

  describe('materialiseTask', () => {
    it('creates a fixed weekly task`s occurrences over the 90 day horizon', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id);
      const now = at('2026-07-06T09:00:00Z');

      const result = await materialiseTask(handle.db, t.id, { now });

      // Mondays from 6 July to 28 September (the horizon ends on Sunday 4 October).
      const rows = await occurrencesOf(t.id);
      expect(rows).toHaveLength(13);
      expect(result.inserted).toBe(13);
      expect(result.occurrenceIds.sort()).toEqual(rows.map((r) => r.id).sort());
      expect(rows[0]?.dueDate).toBe('2026-07-06');
      expect(rows.at(-1)?.dueDate).toBe('2026-09-28');
      expect(rows.every((r) => r.dueAt === null && r.startAt === null)).toBe(true);
      // Today's is already visible; the rest are waiting for their day.
      expect(rows.map((r) => r.status)).toEqual(['active', ...Array(12).fill('upcoming')]);
    });

    it('is idempotent: running twice leaves the same rows', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id);
      const now = at('2026-07-06T09:00:00Z');

      await materialiseTask(handle.db, t.id, { now });
      const before = await occurrencesOf(t.id);
      const again = await materialiseTask(handle.db, t.id, { now });

      expect(again).toEqual({ inserted: 0, occurrenceIds: [] });
      expect(await occurrencesOf(t.id)).toEqual(before);
    });

    it('adds only the newly in-range dues as time passes', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id);
      await materialiseTask(handle.db, t.id, { now: at('2026-07-06T09:00:00Z') });

      const result = await materialiseTask(handle.db, t.id, { now: at('2026-07-13T09:00:00Z') });

      expect(result.inserted).toBe(1);
      expect((await occurrencesOf(t.id)).at(-1)?.dueDate).toBe('2026-10-05');
    });

    it('does not duplicate rows when two callers race', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id);
      const now = at('2026-07-06T09:00:00Z');

      const results = await Promise.all([
        materialiseTask(handle.db, t.id, { now }),
        materialiseTask(handle.db, t.id, { now }),
        materialiseTask(handle.db, t.id, { now }),
      ]);

      expect(await occurrencesOf(t.id)).toHaveLength(13);
      expect(results.reduce((sum, r) => sum + r.inserted, 0)).toBe(13);
    });

    it('sets startAt from the lead time and activates only once it has arrived', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, {
        scheduleKind: 'once',
        rrule: null,
        dueDate: '2026-07-20',
        leadTimeDays: 7,
      });

      await materialiseTask(handle.db, t.id, { now: at('2026-07-12T12:00:00Z') });
      const [early] = await occurrencesOf(t.id);
      // 13 July 00:00 BST.
      expect(early?.startAt).toEqual(at('2026-07-12T23:00:00Z'));
      expect(early?.status).toBe('upcoming');

      await handle.db.delete(occurrence);
      await materialiseTask(handle.db, t.id, { now: at('2026-07-13T08:00:00Z') });
      expect((await occurrencesOf(t.id))[0]?.status).toBe('active');
    });

    it('handles timed tasks', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, {
        scheduleKind: 'once',
        rrule: null,
        dueDate: null,
        allDay: false,
        dueAt: at('2026-07-06T14:30:00Z'),
      });

      await materialiseTask(handle.db, t.id, { now: at('2026-07-06T09:00:00Z') });
      const [row] = await occurrencesOf(t.id);
      expect(row).toMatchObject({
        dueDate: null,
        dueAt: at('2026-07-06T14:30:00Z'),
        status: 'upcoming',
      });

      await handle.db.delete(occurrence);
      await materialiseTask(handle.db, t.id, { now: at('2026-07-06T14:30:00Z') });
      expect((await occurrencesOf(t.id))[0]?.status).toBe('active');
    });

    it('creates a dated once task`s single occurrence, past dues included', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, { scheduleKind: 'once', rrule: null, dueDate: '2026-07-01' });
      const now = at('2026-07-06T09:00:00Z');

      expect((await materialiseTask(handle.db, t.id, { now })).inserted).toBe(1);
      expect((await materialiseTask(handle.db, t.id, { now })).inserted).toBe(0);
      const rows = await occurrencesOf(t.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dueDate: '2026-07-01', status: 'active' });
    });

    it('does not bring a completed once task back', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, { scheduleKind: 'once', rrule: null, dueDate: '2026-07-01' });
      const now = at('2026-07-06T09:00:00Z');
      await materialiseTask(handle.db, t.id, { now });
      await handle.db.update(occurrence).set({ status: 'done', completedAt: now });

      expect((await materialiseTask(handle.db, t.id, { now })).inserted).toBe(0);
      expect(await occurrencesOf(t.id)).toHaveLength(1);
    });

    it('creates exactly one undated occurrence for an undated once task', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, { scheduleKind: 'once', rrule: null, dueDate: null });
      const now = at('2026-07-06T09:00:00Z');

      expect((await materialiseTask(handle.db, t.id, { now })).inserted).toBe(1);
      expect((await materialiseTask(handle.db, t.id, { now })).inserted).toBe(0);
      const rows = await occurrencesOf(t.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        dueDate: null,
        dueAt: null,
        startAt: null,
        status: 'active',
      });

      // Completing it does not make a new one either.
      await handle.db.update(occurrence).set({ status: 'done', completedAt: now });
      expect((await materialiseTask(handle.db, t.id, { now })).inserted).toBe(0);
    });

    it('keeps one open occurrence for an after_completion task and plans the next on completion', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, {
        scheduleKind: 'after_completion',
        rrule: null,
        dueDate: '2026-07-06',
        intervalAfterCompletionDays: 30,
      });
      const now = at('2026-07-06T09:00:00Z');

      expect((await materialiseTask(handle.db, t.id, { now })).inserted).toBe(1);
      expect((await materialiseTask(handle.db, t.id, { now })).inserted).toBe(0);
      // Later ticks do not pile up more while the first is open (or started).
      const [first] = await occurrencesOf(t.id);
      await handle.db.update(occurrence).set({ status: 'started' });
      expect(
        (await materialiseTask(handle.db, t.id, { now: at('2026-08-20T09:00:00Z') })).inserted,
      ).toBe(0);

      const doneAt = at('2026-07-10T18:00:00Z');
      await handle.db
        .update(occurrence)
        .set({ status: 'done', completedAt: doneAt })
        .where(eq(occurrence.id, first?.id ?? ''));
      const next = await materialiseTask(handle.db, t.id, { now: doneAt });

      expect(next.inserted).toBe(1);
      const rows = await occurrencesOf(t.id);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ dueDate: '2026-08-09', status: 'upcoming' });
      expect(next.occurrenceIds).toEqual([rows[1]?.id]);
      expect((await materialiseTask(handle.db, t.id, { now: doneAt })).inserted).toBe(0);
    });

    it('plans from the latest completion when skipped occurrences are involved', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, {
        scheduleKind: 'after_completion',
        rrule: null,
        dueDate: '2026-07-06',
        intervalAfterCompletionDays: 7,
      });
      await insertOccurrence(t.id, {
        dueDate: '2026-07-06',
        status: 'done',
        completedAt: at('2026-07-06T10:00:00Z'),
      });
      await insertOccurrence(t.id, {
        dueDate: '2026-07-13',
        status: 'skipped',
        completedAt: at('2026-07-14T10:00:00Z'),
      });

      await materialiseTask(handle.db, t.id, { now: at('2026-07-14T10:00:00Z') });

      const rows = await occurrencesOf(t.id);
      expect(rows.map((r) => [r.dueDate, r.status])).toEqual([
        ['2026-07-06', 'done'],
        ['2026-07-13', 'skipped'],
        ['2026-07-21', 'upcoming'],
      ]);
    });

    it('anchors an after_completion task to its first due when an undated occurrence is done', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, {
        scheduleKind: 'after_completion',
        rrule: null,
        dueDate: '2026-07-06',
        intervalAfterCompletionDays: 7,
      });
      await insertOccurrence(t.id, { status: 'done', completedAt: at('2026-07-06T10:00:00Z') });

      await materialiseTask(handle.db, t.id, { now: at('2026-07-06T10:00:00Z') });

      expect((await occurrencesOf(t.id)).map((r) => r.dueDate)).toEqual(['2026-07-06', null]);
    });

    it('assigns the first assignee for fixed and rotation tasks, nobody for any', async () => {
      const h = await newHousehold();
      const sam = await newMember(h.id, 'sam');
      const alex = await newMember(h.id, 'alex');
      const now = at('2026-07-06T09:00:00Z');

      for (const [mode, expected] of [
        ['fixed', alex.id],
        ['rotation', alex.id],
        ['any', null],
      ] as const) {
        const t = await newTask(h.id, {
          scheduleKind: 'once',
          rrule: null,
          assignmentMode: mode,
        });
        await handle.db.insert(taskAssignee).values([
          { taskId: t.id, memberId: sam.id, position: 1 },
          { taskId: t.id, memberId: alex.id, position: 0 },
        ]);
        await materialiseTask(handle.db, t.id, { now });
        expect((await occurrencesOf(t.id))[0]?.assigneeId, mode).toBe(expected);
      }
    });

    it('leaves assigneeId empty when the task has no assignees', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, { scheduleKind: 'once', rrule: null });
      await materialiseTask(handle.db, t.id, { now: at('2026-07-06T09:00:00Z') });
      expect((await occurrencesOf(t.id))[0]?.assigneeId).toBeNull();
    });

    it('skips archived and unknown tasks', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, { archivedAt: at('2026-07-01T00:00:00Z') });
      const now = at('2026-07-06T09:00:00Z');

      expect(await materialiseTask(handle.db, t.id, { now })).toEqual({
        inserted: 0,
        occurrenceIds: [],
      });
      expect(await occurrencesOf(t.id)).toHaveLength(0);
      const missing = '00000000-0000-4000-8000-000000000000';
      expect((await materialiseTask(handle.db, missing, { now })).inserted).toBe(0);
    });

    it('uses the household time zone for today`s boundary', async () => {
      const h = await newHousehold('America/New_York');
      const t = await newTask(h.id, { rrule: 'FREQ=DAILY', dueDate: '2026-07-01' });

      // 03:00 UTC on 2 July is still 1 July in New York, so 1 July is the first due.
      await materialiseTask(handle.db, t.id, { now: at('2026-07-02T03:00:00Z') });

      const rows = await occurrencesOf(t.id);
      expect(rows[0]?.dueDate).toBe('2026-07-01');
      expect(rows).toHaveLength(91);
    });

    it('throws a RecurrenceError for a broken schedule', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, { rrule: 'NOT A RULE' });
      await expect(
        materialiseTask(handle.db, t.id, { now: at('2026-07-06T09:00:00Z') }),
      ).rejects.toMatchObject({ name: 'RecurrenceError' });
    });

    it('works inside a transaction and rolls back with it', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id);
      const now = at('2026-07-06T09:00:00Z');

      await expect(
        handle.db.transaction(async (tx) => {
          expect((await materialiseTask(tx, t.id, { now })).inserted).toBe(13);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await occurrencesOf(t.id)).toHaveLength(0);

      await handle.db.transaction(async (tx) => {
        await materialiseTask(tx, t.id, { now });
      });
      expect(await occurrencesOf(t.id)).toHaveLength(13);
    });
  });

  describe('materialiseAll', () => {
    it('covers every household`s active tasks and reports broken ones without stopping', async () => {
      const a = await newHousehold();
      const b = await newHousehold('America/New_York');
      const weekly = await newTask(a.id);
      const once = await newTask(b.id, { scheduleKind: 'once', rrule: null });
      const broken = await newTask(a.id, { title: 'Broken', rrule: 'NOT A RULE' });
      const archived = await newTask(b.id, { archivedAt: at('2026-07-01T00:00:00Z') });
      const now = at('2026-07-06T09:00:00Z');

      const result = await materialiseAll(handle.db, { now });

      expect(result.tasks).toBe(3);
      expect(result.inserted).toBe(14);
      expect(result.failures).toEqual([
        { taskId: broken.id, code: 'invalid_rrule', message: expect.any(String) },
      ]);
      expect(await occurrencesOf(weekly.id)).toHaveLength(13);
      expect(await occurrencesOf(once.id)).toHaveLength(1);
      expect(await occurrencesOf(broken.id)).toHaveLength(0);
      expect(await occurrencesOf(archived.id)).toHaveLength(0);

      const again = await materialiseAll(handle.db, { now });
      expect(again).toMatchObject({ tasks: 3, inserted: 0 });
      expect(again.failures).toHaveLength(1);
    });

    it('does nothing on an empty database', async () => {
      expect(await materialiseAll(handle.db, { now: at('2026-07-06T09:00:00Z') })).toEqual({
        tasks: 0,
        inserted: 0,
        failures: [],
      });
    });

    it('works inside a transaction', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id);
      const result = await handle.db.transaction((tx) =>
        materialiseAll(tx, { now: at('2026-07-06T09:00:00Z') }),
      );
      expect(result.inserted).toBe(13);
      expect(await occurrencesOf(t.id)).toHaveLength(13);
    });
  });

  describe('activateDue', () => {
    const statusOf = async (taskId: string) => (await occurrencesOf(taskId)).map((r) => r.status);

    it('activates an all-day due at local midnight, across the BST boundary', async () => {
      const h = await newHousehold();
      const summer = await newTask(h.id, {
        scheduleKind: 'once',
        rrule: null,
        dueDate: '2026-07-01',
      });
      const winter = await newTask(h.id, {
        scheduleKind: 'once',
        rrule: null,
        dueDate: '2026-01-15',
      });
      await insertOccurrence(summer.id, { dueDate: '2026-07-01', status: 'upcoming' });
      await insertOccurrence(winter.id, { dueDate: '2026-01-15', status: 'upcoming' });

      // 15 January 00:00 GMT is 00:00 UTC (the July due is months away at this point).
      expect(await activateDue(handle.db, { now: at('2026-01-14T23:59:59Z') })).toBe(0);
      expect(await activateDue(handle.db, { now: at('2026-01-15T00:00:00Z') })).toBe(1);
      expect(await statusOf(winter.id)).toEqual(['active']);

      // 1 July 00:00 BST is 30 June 23:00 UTC.
      expect(await activateDue(handle.db, { now: at('2026-06-30T22:59:59Z') })).toBe(0);
      expect(await statusOf(summer.id)).toEqual(['upcoming']);
      expect(await activateDue(handle.db, { now: at('2026-06-30T23:00:00Z') })).toBe(1);
      expect(await statusOf(summer.id)).toEqual(['active']);
    });

    it('uses each household`s own time zone', async () => {
      const ny = await newHousehold('America/New_York');
      const t = await newTask(ny.id, { scheduleKind: 'once', rrule: null, dueDate: '2026-07-01' });
      await insertOccurrence(t.id, { dueDate: '2026-07-01', status: 'upcoming' });

      // Midnight in New York (EDT) is 04:00 UTC.
      expect(await activateDue(handle.db, { now: at('2026-07-01T03:59:59Z') })).toBe(0);
      expect(await activateDue(handle.db, { now: at('2026-07-01T04:00:00Z') })).toBe(1);
    });

    it('activates timed, lead-time and undated occurrences', async () => {
      const h = await newHousehold();
      const timed = await newTask(h.id, {
        scheduleKind: 'once',
        rrule: null,
        dueDate: null,
        allDay: false,
        dueAt: at('2026-07-06T14:30:00Z'),
      });
      const lead = await newTask(h.id, {
        scheduleKind: 'once',
        rrule: null,
        dueDate: '2026-07-20',
      });
      const undated = await newTask(h.id, { scheduleKind: 'once', rrule: null, dueDate: null });
      await insertOccurrence(timed.id, { dueAt: at('2026-07-06T14:30:00Z'), status: 'upcoming' });
      await insertOccurrence(lead.id, {
        dueDate: '2026-07-20',
        startAt: at('2026-07-12T23:00:00Z'),
        status: 'upcoming',
      });
      await insertOccurrence(undated.id, { status: 'upcoming' });

      // Only the undated one is due before anything else.
      expect(await activateDue(handle.db, { now: at('2026-07-06T14:29:59Z') })).toBe(1);
      expect(await statusOf(undated.id)).toEqual(['active']);
      expect(await statusOf(timed.id)).toEqual(['upcoming']);

      expect(await activateDue(handle.db, { now: at('2026-07-06T14:30:00Z') })).toBe(1);
      expect(await statusOf(timed.id)).toEqual(['active']);

      // The lead time makes a 20 July due visible from 13 July, long before the date itself.
      expect(await activateDue(handle.db, { now: at('2026-07-12T22:59:59Z') })).toBe(0);
      expect(await activateDue(handle.db, { now: at('2026-07-12T23:00:00Z') })).toBe(1);
      expect(await statusOf(lead.id)).toEqual(['active']);
    });

    it('is idempotent and leaves other statuses alone', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, { scheduleKind: 'once', rrule: null, dueDate: null });
      for (const [i, status] of (
        ['upcoming', 'started', 'done', 'skipped', 'active'] as const
      ).entries()) {
        await insertOccurrence(t.id, { dueDate: `2026-06-0${i + 1}`, status });
      }
      const now = at('2026-07-06T09:00:00Z');

      expect(await activateDue(handle.db, { now })).toBe(1);
      expect(await activateDue(handle.db, { now })).toBe(0);
      expect(await statusOf(t.id)).toEqual(['active', 'started', 'done', 'skipped', 'active']);
    });

    it('promotes what materialiseTask left upcoming once its day comes', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id);
      await materialiseTask(handle.db, t.id, { now: at('2026-07-06T09:00:00Z') });

      // Monday 13 July starts at 12 July 23:00 UTC (BST).
      const activated = await activateDue(handle.db, { now: at('2026-07-12T23:00:00Z') });

      expect(activated).toBe(1);
      expect((await occurrencesOf(t.id)).map((r) => r.status).slice(0, 3)).toEqual([
        'active',
        'active',
        'upcoming',
      ]);
    });

    it('works inside a transaction', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, { scheduleKind: 'once', rrule: null, dueDate: null });
      await insertOccurrence(t.id, { status: 'upcoming' });
      const count = await handle.db.transaction((tx) =>
        activateDue(tx, { now: at('2026-07-06T09:00:00Z') }),
      );
      expect(count).toBe(1);
    });
  });

  describe('clearFutureOpenOccurrences', () => {
    it('deletes upcoming/active occurrences due today or later and undated ones', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id);
      const other = await newTask(h.id, { title: 'Other' });
      await insertOccurrence(t.id, { dueDate: '2026-07-05', status: 'active' }); // overdue: keep
      await insertOccurrence(t.id, { dueDate: '2026-07-06', status: 'active' }); // today
      await insertOccurrence(t.id, { dueDate: '2026-07-13', status: 'upcoming' });
      await insertOccurrence(t.id, { dueDate: '2026-07-20', status: 'started' }); // keep
      await insertOccurrence(t.id, { dueDate: '2026-07-27', status: 'done' }); // keep
      await insertOccurrence(t.id, { dueDate: '2026-08-03', status: 'skipped' }); // keep
      await insertOccurrence(t.id, { dueAt: at('2026-07-06T20:00:00Z'), status: 'upcoming' });
      await insertOccurrence(t.id, { status: 'active' }); // undated
      await insertOccurrence(other.id, { dueDate: '2026-07-13', status: 'upcoming' });

      const result = await clearFutureOpenOccurrences(handle.db, t.id, {
        now: at('2026-07-06T09:00:00Z'),
      });

      expect(result).toEqual({ deleted: 4 });
      expect((await occurrencesOf(t.id)).map((r) => [r.dueDate, r.status])).toEqual([
        ['2026-07-05', 'active'],
        ['2026-07-20', 'started'],
        ['2026-07-27', 'done'],
        ['2026-08-03', 'skipped'],
      ]);
      expect(await occurrencesOf(other.id)).toHaveLength(1);
    });

    it('draws the line at local midnight for timed dues', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, { scheduleKind: 'once', rrule: null, dueDate: null });
      // 1 July in London starts at 30 June 23:00 UTC.
      await insertOccurrence(t.id, { dueAt: at('2026-06-30T22:59:00Z'), status: 'active' });
      await insertOccurrence(t.id, { dueAt: at('2026-06-30T23:00:00Z'), status: 'active' });

      await clearFutureOpenOccurrences(handle.db, t.id, { now: at('2026-07-01T10:00:00Z') });

      expect((await occurrencesOf(t.id)).map((r) => r.dueAt)).toEqual([at('2026-06-30T22:59:00Z')]);
    });

    it('followed by materialiseTask rebuilds the series from a changed schedule', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id);
      const now = at('2026-07-06T09:00:00Z');
      await materialiseTask(handle.db, t.id, { now });

      await handle.db.update(task).set({ rrule: 'FREQ=WEEKLY;BYDAY=FR' }).where(eq(task.id, t.id));
      await clearFutureOpenOccurrences(handle.db, t.id, { now });
      await materialiseTask(handle.db, t.id, { now });

      const rows = await occurrencesOf(t.id);
      // The Monday due is gone; Fridays take over.
      expect(rows).toHaveLength(13);
      expect(rows.slice(0, 2).map((r) => r.dueDate)).toEqual(['2026-07-10', '2026-07-17']);
    });

    it('returns zero for an unknown task', async () => {
      const result = await clearFutureOpenOccurrences(
        handle.db,
        '00000000-0000-4000-8000-000000000000',
        { now: at('2026-07-06T09:00:00Z') },
      );
      expect(result).toEqual({ deleted: 0 });
    });
  });

  describe('reassignOpenOccurrences', () => {
    it('moves upcoming and active occurrences to the first assignee, not started ones', async () => {
      const h = await newHousehold();
      const sam = await newMember(h.id, 'sam');
      const alex = await newMember(h.id, 'alex');
      const t = await newTask(h.id, { scheduleKind: 'once', rrule: null, dueDate: null });
      await insertOccurrence(t.id, { dueDate: '2026-07-06', status: 'active', assigneeId: sam.id });
      await insertOccurrence(t.id, {
        dueDate: '2026-07-13',
        status: 'upcoming',
        assigneeId: sam.id,
      });
      await insertOccurrence(t.id, {
        dueDate: '2026-07-20',
        status: 'started',
        assigneeId: sam.id,
      });
      await insertOccurrence(t.id, { dueDate: '2026-07-27', status: 'done', assigneeId: sam.id });
      await handle.db.insert(taskAssignee).values({ taskId: t.id, memberId: alex.id, position: 0 });

      expect(await reassignOpenOccurrences(handle.db, t.id)).toEqual({ updated: 2 });
      expect((await occurrencesOf(t.id)).map((r) => r.assigneeId)).toEqual([
        alex.id,
        alex.id,
        sam.id,
        sam.id,
      ]);

      await handle.db.update(task).set({ assignmentMode: 'any' }).where(eq(task.id, t.id));
      await reassignOpenOccurrences(handle.db, t.id);
      const open = await handle.db
        .select({ assigneeId: occurrence.assigneeId })
        .from(occurrence)
        .where(and(eq(occurrence.taskId, t.id), eq(occurrence.status, 'active')));
      expect(open).toEqual([{ assigneeId: null }]);
    });

    it('returns zero for an unknown task', async () => {
      expect(
        await reassignOpenOccurrences(handle.db, '00000000-0000-4000-8000-000000000000'),
      ).toEqual({ updated: 0 });
    });
  });
});
