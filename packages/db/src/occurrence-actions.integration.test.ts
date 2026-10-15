import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from './client.js';
import { materialiseTask } from './materialise.js';
import { runMigrations } from './migrate.js';
import {
  applyOccurrenceAction,
  OccurrenceActionError,
  type OccurrenceAction,
} from './occurrence-actions.js';
import {
  activity,
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
const now = at('2026-07-06T09:00:00Z');
const MISSING = '00000000-0000-4000-8000-000000000000';
let memberCount = 0;

describe.skipIf(!adminUrl)('occurrence actions (integration)', () => {
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

  async function newHousehold() {
    const [h] = await handle.db.insert(household).values({ name: 'Test' }).returning();
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
        scheduleKind: 'once',
        rrule: null,
        dueDate: '2026-07-06',
        ...values,
      })
      .returning();
    if (!t) throw new Error('insert failed');
    return t;
  }

  async function newOccurrence(taskId: string, values: Partial<NewOccurrence> = {}) {
    const [o] = await handle.db
      .insert(occurrence)
      .values({ taskId, dueDate: '2026-07-06', status: 'active', ...values })
      .returning();
    if (!o) throw new Error('insert failed');
    return o;
  }

  /** A household with a member and one active occurrence of a task. */
  async function setUp(taskValues: Partial<NewTask> = {}) {
    const h = await newHousehold();
    const m = await newMember(h.id, `sam${++memberCount}`);
    const t = await newTask(h.id, taskValues);
    const o = await newOccurrence(t.id);
    return { h, m, t, o };
  }

  const act = (
    ctx: { h: { id: string }; m: { id: string }; o: { id: string } },
    action: OccurrenceAction,
    at = now,
  ) =>
    applyOccurrenceAction(handle.db, {
      householdId: ctx.h.id,
      memberId: ctx.m.id,
      occurrenceId: ctx.o.id,
      now: at,
      action,
    });

  const reload = async (id: string) => {
    const [row] = await handle.db.select().from(occurrence).where(eq(occurrence.id, id));
    return row;
  };

  const activitiesOf = (taskId: string) =>
    handle.db
      .select()
      .from(activity)
      .where(eq(activity.taskId, taskId))
      .orderBy(asc(activity.createdAt));

  const failure = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OccurrenceActionError);
    return error as OccurrenceActionError;
  };

  describe('complete', () => {
    it('marks the occurrence done by the member, clears a snooze and logs it', async () => {
      const ctx = await setUp();
      await handle.db
        .update(occurrence)
        .set({ snoozedUntil: at('2026-07-07T09:00:00Z') })
        .where(eq(occurrence.id, ctx.o.id));

      const result = await act(ctx, { type: 'complete' });

      expect(result).toEqual({ taskId: ctx.t.id, status: 'done', changed: true, createdIds: [] });
      const row = await reload(ctx.o.id);
      expect(row).toMatchObject({ status: 'done', completedBy: ctx.m.id, snoozedUntil: null });
      expect(row?.completedAt).toEqual(now);
      const [logged, ...rest] = await activitiesOf(ctx.t.id);
      expect(rest).toEqual([]);
      expect(logged).toMatchObject({
        householdId: ctx.h.id,
        memberId: ctx.m.id,
        occurrenceId: ctx.o.id,
        kind: 'occurrence.completed',
        data: { title: 'Bins' },
      });
    });

    it('creates the next occurrence of an after_completion task', async () => {
      const ctx = await setUp({
        scheduleKind: 'after_completion',
        rrule: null,
        intervalAfterCompletionDays: 30,
      });

      const result = await act(ctx, { type: 'complete' });

      expect(result.createdIds).toHaveLength(1);
      const next = await reload(result.createdIds[0] as string);
      expect(next).toMatchObject({ taskId: ctx.t.id, dueDate: '2026-08-05', status: 'upcoming' });
    });

    it('reports the occurrences the schedule created for a recurring task', async () => {
      const ctx = await setUp({ scheduleKind: 'fixed', rrule: 'FREQ=WEEKLY;BYDAY=MO' });

      const { createdIds } = await act(ctx, { type: 'complete' });

      // The existing occurrence is closed; the schedule fills the horizon after it.
      const rows = await handle.db.select().from(occurrence).where(eq(occurrence.taskId, ctx.t.id));
      expect(createdIds.length).toBeGreaterThan(0);
      expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(createdIds));
    });

    it('completes a started occurrence, and one that is snoozed', async () => {
      const started = await setUp();
      await handle.db.update(occurrence).set({ status: 'started' });
      expect((await act(started, { type: 'complete' })).status).toBe('done');

      const snoozed = await setUp();
      await act(snoozed, { type: 'snooze', until: at('2026-07-08T09:00:00Z') });
      expect((await act(snoozed, { type: 'complete' })).status).toBe('done');
    });

    it('uses up the assignee`s rotation turn once', async () => {
      const h = await newHousehold();
      const [a, b] = [await newMember(h.id, 'a'), await newMember(h.id, 'b')] as const;
      const t = await newTask(h.id, {
        assignmentMode: 'rotation',
        scheduleKind: 'fixed',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      });
      await handle.db.insert(taskAssignee).values([
        { taskId: t.id, memberId: a.id, position: 0 },
        { taskId: t.id, memberId: b.id, position: 1 },
      ]);
      await materialiseTask(handle.db, t.id, { now });
      const [first, second] = await handle.db
        .select()
        .from(occurrence)
        .where(eq(occurrence.taskId, t.id))
        .orderBy(asc(occurrence.dueDate));
      expect([first?.assigneeId, second?.assigneeId]).toEqual([a.id, b.id]);

      // B completes A's turn: A's turn is used up, so B is next and the plan holds.
      const ctx = { h, m: b, o: first as { id: string } };
      await act(ctx, { type: 'complete' });
      const cursor = async () =>
        (await handle.db.select({ c: task.rotationCursor }).from(task).where(eq(task.id, t.id)))[0]
          ?.c;
      expect(await cursor()).toBe(1);

      // A second completion of the same occurrence is refused and moves nothing.
      await failure(act(ctx, { type: 'complete' }));
      expect(await cursor()).toBe(1);
    });

    it('lets only one of two simultaneous completions through', async () => {
      const ctx = await setUp();

      const results = await Promise.allSettled([
        act(ctx, { type: 'complete' }),
        act(ctx, { type: 'complete' }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(await activitiesOf(ctx.t.id)).toHaveLength(1);
    });
  });

  describe('skip', () => {
    it('marks the occurrence skipped by the member and logs it', async () => {
      const ctx = await setUp();

      const result = await act(ctx, { type: 'skip' });

      expect(result).toEqual({
        taskId: ctx.t.id,
        status: 'skipped',
        changed: true,
        createdIds: [],
      });
      expect(await reload(ctx.o.id)).toMatchObject({
        status: 'skipped',
        completedBy: ctx.m.id,
      });
      expect((await activitiesOf(ctx.t.id)).map((a) => a.kind)).toEqual(['occurrence.skipped']);
    });

    it('still creates the next occurrence of an after_completion task', async () => {
      const ctx = await setUp({
        scheduleKind: 'after_completion',
        rrule: null,
        intervalAfterCompletionDays: 7,
      });
      const result = await act(ctx, { type: 'skip' });
      expect(result.createdIds).toHaveLength(1);
    });
  });

  describe('snooze', () => {
    it('hides the occurrence until the time and logs it, without closing it', async () => {
      const ctx = await setUp();
      const until = at('2026-07-06T18:00:00Z');

      const result = await act(ctx, { type: 'snooze', until });

      expect(result).toEqual({ taskId: ctx.t.id, status: 'active', changed: true, createdIds: [] });
      expect((await reload(ctx.o.id))?.snoozedUntil).toEqual(until);
      const [logged] = await activitiesOf(ctx.t.id);
      expect(logged).toMatchObject({
        kind: 'occurrence.snoozed',
        data: { title: 'Bins', until: until.toISOString() },
      });
    });

    it('can be repeated, and leaves a started occurrence started', async () => {
      const ctx = await setUp();
      await act(ctx, { type: 'snooze', until: at('2026-07-06T18:00:00Z') });
      await handle.db.update(occurrence).set({ status: 'started' });

      const result = await act(ctx, { type: 'snooze', until: at('2026-07-09T18:00:00Z') });

      expect(result.status).toBe('started');
      expect((await reload(ctx.o.id))?.snoozedUntil).toEqual(at('2026-07-09T18:00:00Z'));
    });
  });

  describe('start', () => {
    it('marks the occurrence started, ends a snooze and logs it', async () => {
      const ctx = await setUp();
      await act(ctx, { type: 'snooze', until: at('2026-07-06T18:00:00Z') });

      const result = await act(ctx, { type: 'start' });

      expect(result).toEqual({
        taskId: ctx.t.id,
        status: 'started',
        changed: true,
        createdIds: [],
      });
      expect(await reload(ctx.o.id)).toMatchObject({ status: 'started', snoozedUntil: null });
      expect((await activitiesOf(ctx.t.id)).map((a) => a.kind)).toEqual([
        'occurrence.snoozed',
        'occurrence.started',
      ]);
    });

    it('is idempotent: starting a started occurrence changes and logs nothing', async () => {
      const ctx = await setUp();
      await act(ctx, { type: 'start' });

      const result = await act(ctx, { type: 'start' });

      expect(result).toEqual({
        taskId: ctx.t.id,
        status: 'started',
        changed: false,
        createdIds: [],
      });
      expect(await activitiesOf(ctx.t.id)).toHaveLength(1);
    });
  });

  describe('refusals', () => {
    const actions: [string, OccurrenceAction][] = [
      ['complete', { type: 'complete' }],
      ['skip', { type: 'skip' }],
      ['snooze', { type: 'snooze', until: at('2026-07-09T18:00:00Z') }],
      ['start', { type: 'start' }],
    ];

    it.each(actions)(
      '%s: a closed occurrence is occurrence_closed with its status',
      async (_, action) => {
        for (const status of ['done', 'skipped'] as const) {
          const ctx = await setUp();
          await handle.db.update(occurrence).set({ status }).where(eq(occurrence.id, ctx.o.id));

          const error = await failure(act(ctx, action));

          expect(error).toMatchObject({ code: 'occurrence_closed', status });
          expect(error.message).toBe(`That occurrence is already ${status}`);
          expect(await activitiesOf(ctx.t.id)).toEqual([]);
        }
      },
    );

    it.each(actions)('%s: an unknown occurrence is not_found', async (_, action) => {
      const ctx = await setUp();
      const error = await failure(act({ ...ctx, o: { id: MISSING } }, action));
      expect(error).toMatchObject({ code: 'not_found', status: undefined });
      expect(error.message).toBe('No such occurrence');
    });

    it.each(actions)(
      '%s: another household`s occurrence is not_found and untouched',
      async (_, action) => {
        const mine = await setUp();
        const theirs = await setUp();

        const error = await failure(act({ h: mine.h, m: mine.m, o: theirs.o }, action));

        expect(error.code).toBe('not_found');
        expect(await reload(theirs.o.id)).toMatchObject({ status: 'active', snoozedUntil: null });
        expect(await activitiesOf(theirs.t.id)).toEqual([]);
      },
    );

    it('a failed action leaves the occurrence as it was', async () => {
      const ctx = await setUp();
      await handle.db.update(occurrence).set({ status: 'done' });
      await failure(act(ctx, { type: 'snooze', until: at('2026-07-09T18:00:00Z') }));
      expect(
        await handle.db
          .select()
          .from(occurrence)
          .where(and(eq(occurrence.id, ctx.o.id), eq(occurrence.status, 'done'))),
      ).toHaveLength(1);
    });
  });
});
