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
import { consumeRotationTurn, replanRotation, replanRotationsForMember } from './rotation.js';
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

      expect(result).toMatchObject({ deleted: 4 });
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
      expect(result).toEqual({ deleted: 0, sourceDueKeys: [] });
    });
  });

  describe('reassignOpenOccurrences', () => {
    const now = at('2026-07-06T09:00:00Z');

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

      expect(await reassignOpenOccurrences(handle.db, t.id, { now })).toEqual({ updated: 2 });
      expect((await occurrencesOf(t.id)).map((r) => r.assigneeId)).toEqual([
        alex.id,
        alex.id,
        sam.id,
        sam.id,
      ]);

      await handle.db.update(task).set({ assignmentMode: 'any' }).where(eq(task.id, t.id));
      await reassignOpenOccurrences(handle.db, t.id, { now });
      const open = await handle.db
        .select({ assigneeId: occurrence.assigneeId })
        .from(occurrence)
        .where(and(eq(occurrence.taskId, t.id), eq(occurrence.status, 'active')));
      expect(open).toEqual([{ assigneeId: null }]);
    });

    it('returns zero for an unknown task', async () => {
      expect(
        await reassignOpenOccurrences(handle.db, '00000000-0000-4000-8000-000000000000', { now }),
      ).toEqual({ updated: 0 });
    });
  });
  describe('rotation', () => {
    const now = at('2026-07-06T09:00:00Z');

    /** A weekly (Monday) rotation task over the given members, in order. */
    async function rotationTask(householdId: string, members: { id: string }[], cursor = 0) {
      const t = await newTask(householdId, { assignmentMode: 'rotation', rotationCursor: cursor });
      if (members.length > 0) {
        await handle.db
          .insert(taskAssignee)
          .values(members.map((m, position) => ({ taskId: t.id, memberId: m.id, position })));
      }
      return t;
    }

    const assigneesOf = async (taskId: string, ...names: Record<string, string>[]) => {
      const byId = Object.assign({}, ...names) as Record<string, string>;
      return (await occurrencesOf(taskId)).map((r) => (r.assigneeId && byId[r.assigneeId]) || null);
    };

    async function setUp() {
      const h = await newHousehold();
      const [a, b, c] = [
        await newMember(h.id, 'a'),
        await newMember(h.id, 'b'),
        await newMember(h.id, 'c'),
      ] as const;
      const names = { [a.id]: 'A', [b.id]: 'B', [c.id]: 'C' };
      return { h, a, b, c, names };
    }

    const cursorOf = async (taskId: string) =>
      (
        await handle.db
          .select({ cursor: task.rotationCursor })
          .from(task)
          .where(eq(task.id, taskId))
      )[0]?.cursor;

    it('hands a weekly task`s occurrences to its assignees in turn', async () => {
      const { h, a, b, c, names } = await setUp();
      const t = await rotationTask(h.id, [a, b, c]);

      await materialiseTask(handle.db, t.id, { now });

      const got = await assigneesOf(t.id, names);
      expect(got.slice(0, 7)).toEqual(['A', 'B', 'C', 'A', 'B', 'C', 'A']);
      expect(got).toHaveLength(13);
    });

    it('starts from the task`s cursor', async () => {
      const { h, a, b, c, names } = await setUp();
      const t = await rotationTask(h.id, [a, b, c], 1);
      await materialiseTask(handle.db, t.id, { now });
      expect((await assigneesOf(t.id, names)).slice(0, 4)).toEqual(['B', 'C', 'A', 'B']);
    });

    it('does nothing when run again with the same inputs', async () => {
      const { h, a, b, c } = await setUp();
      const t = await rotationTask(h.id, [a, b, c]);
      await materialiseTask(handle.db, t.id, { now });
      const before = await occurrencesOf(t.id);

      expect(await replanRotation(handle.db, t.id, { now })).toEqual({ updated: 0 });
      expect(await reassignOpenOccurrences(handle.db, t.id, { now })).toEqual({ updated: 0 });
      expect(await materialiseTask(handle.db, t.id, { now })).toEqual({
        inserted: 0,
        occurrenceIds: [],
      });
      expect(await occurrencesOf(t.id)).toEqual(before);
    });

    it('continues the rotation when later occurrences are materialised', async () => {
      const { h, a, b, c, names } = await setUp();
      const t = await rotationTask(h.id, [a, b, c]);
      await materialiseTask(handle.db, t.id, { now });
      await materialiseTask(handle.db, t.id, { now: at('2026-07-13T09:00:00Z') });

      const got = await assigneesOf(t.id, names);
      expect(got).toHaveLength(14);
      expect(got.slice(0, 5)).toEqual(['A', 'B', 'C', 'A', 'B']);
    });

    it('skips a member on the dates they are away, and puts them back when they return', async () => {
      const { h, a, b, c, names } = await setUp();
      const t = await rotationTask(h.id, [a, b, c]);
      await materialiseTask(handle.db, t.id, { now });

      // B is away through Tuesday 14 July, so the 13th goes to C and the turn moves on to A.
      await handle.db.update(member).set({ awayUntil: '2026-07-14' }).where(eq(member.id, b.id));
      expect(await replanRotationsForMember(handle.db, b.id, { now })).toEqual({ updated: 12 });
      expect((await assigneesOf(t.id, names)).slice(0, 6)).toEqual(['A', 'C', 'A', 'B', 'C', 'A']);

      await handle.db.update(member).set({ awayUntil: null }).where(eq(member.id, b.id));
      await replanRotationsForMember(handle.db, b.id, { now });
      expect((await assigneesOf(t.id, names)).slice(0, 4)).toEqual(['A', 'B', 'C', 'A']);
    });

    it('treats the away date as the last day away', async () => {
      const { h, a, b, names } = await setUp();
      const t = await rotationTask(h.id, [a, b], 1);
      await materialiseTask(handle.db, t.id, { now });
      // B is next for Monday 6th but away through that very day; back for the 13th.
      await handle.db.update(member).set({ awayUntil: '2026-07-06' }).where(eq(member.id, b.id));
      await replanRotationsForMember(handle.db, b.id, { now });
      expect((await assigneesOf(t.id, names)).slice(0, 4)).toEqual(['A', 'B', 'A', 'B']);
    });

    it('only re-plans rotation tasks the member is in', async () => {
      const { h, a, b, c } = await setUp();
      const mine = await rotationTask(h.id, [a, b]);
      const others = await rotationTask(h.id, [b, c]);
      const fixed = await newTask(h.id, { assignmentMode: 'fixed' });
      await handle.db
        .insert(taskAssignee)
        .values({ taskId: fixed.id, memberId: a.id, position: 0 });
      for (const t of [mine, others, fixed]) await materialiseTask(handle.db, t.id, { now });
      const untouched = [await occurrencesOf(others.id), await occurrencesOf(fixed.id)];

      await handle.db.update(member).set({ awayUntil: '2026-07-31' }).where(eq(member.id, a.id));
      const { updated } = await replanRotationsForMember(handle.db, a.id, { now });

      expect(updated).toBeGreaterThan(0);
      expect([await occurrencesOf(others.id), await occurrencesOf(fixed.id)]).toEqual(untouched);
      // Away through July: B has the first five Mondays of `mine`.
      expect((await occurrencesOf(mine.id)).slice(0, 4).map((r) => r.assigneeId)).toEqual([
        b.id,
        b.id,
        b.id,
        b.id,
      ]);
    });

    it('leaves archived tasks alone when a member`s away date changes', async () => {
      const { h, a, b } = await setUp();
      const t = await rotationTask(h.id, [a, b]);
      await materialiseTask(handle.db, t.id, { now });
      await handle.db.update(task).set({ archivedAt: now }).where(eq(task.id, t.id));
      const before = await occurrencesOf(t.id);

      await handle.db.update(member).set({ awayUntil: '2026-12-31' }).where(eq(member.id, a.id));

      expect(await replanRotationsForMember(handle.db, a.id, { now })).toEqual({ updated: 0 });
      expect(await occurrencesOf(t.id)).toEqual(before);
    });

    it('lets the member whose turn it is take an occurrence when everyone is away', async () => {
      const { h, a, b, names } = await setUp();
      const t = await rotationTask(h.id, [a, b]);
      await handle.db.update(member).set({ awayUntil: '2026-08-31' }).where(eq(member.id, a.id));
      await handle.db.update(member).set({ awayUntil: '2026-08-31' }).where(eq(member.id, b.id));
      await materialiseTask(handle.db, t.id, { now });
      expect((await assigneesOf(t.id, names)).slice(0, 5)).toEqual(['A', 'B', 'A', 'B', 'A']);
    });

    it('leaves occurrences unassigned when the rotation has no members', async () => {
      const h = await newHousehold();
      const t = await rotationTask(h.id, []);
      await materialiseTask(handle.db, t.id, { now });
      expect(new Set((await occurrencesOf(t.id)).map((r) => r.assigneeId))).toEqual(
        new Set([null]),
      );
    });

    it('orders timed, all-day and undated occurrences by due and plans in household time', async () => {
      const { h, a, b, c, names } = await setUp();
      const t = await rotationTask(h.id, [a, b, c]);
      // 23:30 UTC on the 10th is 00:30 on the 11th in London (BST).
      await insertOccurrence(t.id, { dueAt: at('2026-07-10T23:30:00Z'), status: 'upcoming' });
      await insertOccurrence(t.id, { dueDate: '2026-07-10', status: 'upcoming' });
      await insertOccurrence(t.id, { status: 'active' });
      await handle.db.update(member).set({ awayUntil: '2026-07-10' }).where(eq(member.id, b.id));

      await replanRotation(handle.db, t.id, { now });

      const rows = await occurrencesOf(t.id);
      const by = (pick: (r: (typeof rows)[number]) => boolean) =>
        rows.filter(pick).map((r) => names[r.assigneeId as string]);
      // All-day 10th: A. Timed (the 11th locally): B is back. Undated (today, 6th): C.
      expect(by((r) => r.dueDate === '2026-07-10')).toEqual(['A']);
      expect(by((r) => r.dueAt !== null)).toEqual(['B']);
      expect(by((r) => r.dueDate === null && r.dueAt === null)).toEqual(['C']);
    });

    it('treats an undated occurrence as due today when checking who is away', async () => {
      const { h, a, b, names } = await setUp();
      const t = await rotationTask(h.id, [a, b], 1);
      await insertOccurrence(t.id, { status: 'active' });
      await handle.db.update(member).set({ awayUntil: '2026-07-06' }).where(eq(member.id, b.id));
      await replanRotation(handle.db, t.id, { now });
      expect(await assigneesOf(t.id, names)).toEqual(['A']);
    });

    it('does not touch started, done or skipped occurrences', async () => {
      const { h, a, b } = await setUp();
      const t = await rotationTask(h.id, [a, b]);
      for (const [i, status] of (['started', 'done', 'skipped', 'upcoming'] as const).entries()) {
        await insertOccurrence(t.id, { dueDate: `2026-07-1${i}`, status, assigneeId: b.id });
      }
      expect(await reassignOpenOccurrences(handle.db, t.id, { now })).toEqual({ updated: 1 });
      expect((await occurrencesOf(t.id)).map((r) => r.assigneeId)).toEqual([
        b.id,
        b.id,
        b.id,
        a.id,
      ]);
    });

    it('ignores tasks that are not rotations', async () => {
      const { h, a, b } = await setUp();
      const t = await newTask(h.id, { assignmentMode: 'fixed', rotationCursor: 0 });
      await handle.db.insert(taskAssignee).values({ taskId: t.id, memberId: b.id, position: 0 });
      await materialiseTask(handle.db, t.id, { now });
      const before = await occurrencesOf(t.id);

      expect(await replanRotation(handle.db, t.id, { now })).toEqual({ updated: 0 });
      expect(
        await replanRotation(handle.db, '00000000-0000-4000-8000-000000000000', { now }),
      ).toEqual({ updated: 0 });
      const [first] = before;
      await consumeRotationTurn(handle.db, first?.id as string, { now, previousStatus: 'active' });
      await consumeRotationTurn(handle.db, '00000000-0000-4000-8000-000000000000', {
        now,
        previousStatus: 'active',
      });
      expect(await cursorOf(t.id)).toBe(0);
      expect(await occurrencesOf(t.id)).toEqual(before);
      expect(a.id).not.toBe(b.id);
    });

    describe('consumeRotationTurn', () => {
      it('moves the cursor past the assignee of a completed occurrence and keeps the plan', async () => {
        const { h, a, b, c, names } = await setUp();
        const t = await rotationTask(h.id, [a, b, c]);
        await materialiseTask(handle.db, t.id, { now });
        const [first] = await occurrencesOf(t.id);
        await handle.db
          .update(occurrence)
          .set({ status: 'done', completedBy: c.id })
          .where(eq(occurrence.id, first?.id as string));

        await consumeRotationTurn(handle.db, first?.id as string, {
          now,
          previousStatus: 'active',
        });

        // A's turn is used up even though C did it; B is next, so nothing else moves.
        expect(await cursorOf(t.id)).toBe(1);
        expect((await assigneesOf(t.id, names)).slice(0, 4)).toEqual(['A', 'B', 'C', 'A']);
      });

      it('re-plans the rest when an occurrence is handled out of order', async () => {
        const { h, a, b, c, names } = await setUp();
        const t = await rotationTask(h.id, [a, b, c]);
        await materialiseTask(handle.db, t.id, { now });
        const third = (await occurrencesOf(t.id))[2];
        await handle.db
          .update(occurrence)
          .set({ status: 'started' })
          .where(eq(occurrence.id, third?.id as string));

        await consumeRotationTurn(handle.db, third?.id as string, {
          now,
          previousStatus: 'active',
        });

        // C's turn was used, so A is next for the earliest remaining occurrence: the fourth
        // (which was A's) is now C's, and the rotation goes on from there.
        expect(await cursorOf(t.id)).toBe(0);
        expect((await assigneesOf(t.id, names)).slice(0, 5)).toEqual(['A', 'B', 'C', 'C', 'A']);
        expect((await occurrencesOf(t.id))[2]?.status).toBe('started');
      });

      it('does nothing for an occurrence that was already started, done or skipped', async () => {
        const { h, a, b, c, names } = await setUp();
        const t = await rotationTask(h.id, [a, b, c]);
        await materialiseTask(handle.db, t.id, { now });
        const before = await occurrencesOf(t.id);
        const [first] = before;

        // Completing or skipping a started occurrence: its turn was used up when it started.
        for (const previousStatus of ['started', 'done', 'skipped'] as const) {
          await consumeRotationTurn(handle.db, first?.id as string, { now, previousStatus });
        }

        expect(await cursorOf(t.id)).toBe(0);
        expect(await occurrencesOf(t.id)).toEqual(before);
        expect((await assigneesOf(t.id, names)).slice(0, 3)).toEqual(['A', 'B', 'C']);

        await consumeRotationTurn(handle.db, first?.id as string, {
          now,
          previousStatus: 'upcoming',
        });
        expect(await cursorOf(t.id)).toBe(1);
      });

      it('moves on by one when the assignee is nobody or has left the rotation', async () => {
        const { h, a, b } = await setUp();
        const t = await rotationTask(h.id, [a], 0);
        await handle.db.insert(taskAssignee).values({ taskId: t.id, memberId: b.id, position: 1 });
        await insertOccurrence(t.id, { dueDate: '2026-07-06', status: 'done', assigneeId: null });
        await insertOccurrence(t.id, { dueDate: '2026-07-13', status: 'done', assigneeId: null });
        const [first] = await occurrencesOf(t.id);

        await consumeRotationTurn(handle.db, first?.id as string, {
          now,
          previousStatus: 'active',
        });
        expect(await cursorOf(t.id)).toBe(1);
        await consumeRotationTurn(handle.db, first?.id as string, {
          now,
          previousStatus: 'active',
        });
        expect(await cursorOf(t.id)).toBe(0);
      });
    });
  });
});
