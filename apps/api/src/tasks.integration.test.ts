import { activity, household, occurrence, task, taskAssignee, type DbHandle } from '@tracker/db';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TestClient,
  addMember,
  addOutsider,
  createMigratedDatabase,
  createTestApp,
  setUpAdmin,
  type TestApp,
} from './test-util.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

const DAY = 24 * 60 * 60 * 1000;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!adminUrl)('tasks (integration)', () => {
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let handle: DbHandle;
  let t: TestApp;
  let app: FastifyInstance;
  let admin: TestClient;

  beforeAll(async () => {
    database = await createMigratedDatabase(adminUrl as string);
    handle = database.handle;
  });
  afterAll(() => database?.close());

  beforeEach(async () => {
    await handle.sql`truncate household cascade`;
    // Long sessions, so tests can move the clock days ahead.
    t = createTestApp(handle, { sessionTtlMs: 365 * DAY });
    app = t.app;
    admin = await setUpAdmin(app);
  });

  const onceBody = { title: 'Put the bins out', scheduleKind: 'once', dueDate: '2026-03-05' };
  const weeklyBody = {
    title: 'Hoover',
    scheduleKind: 'fixed',
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    dueDate: '2026-03-02',
  };

  async function createTask(body: Json, client: TestClient = admin): Promise<Json> {
    const res = await client.post('/api/tasks', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Json>().task;
  }

  const occurrencesOf = (taskId: string) =>
    handle.db
      .select()
      .from(occurrence)
      .where(eq(occurrence.taskId, taskId))
      .orderBy(asc(occurrence.dueDate), asc(occurrence.dueAt));

  const activityKinds = async () =>
    (await handle.db.select().from(activity).orderBy(asc(activity.createdAt))).map((a) => a.kind);

  describe('access', () => {
    it('needs a session on every route', async () => {
      const anon = new TestClient(app);
      const id = '00000000-0000-4000-8000-000000000000';
      for (const [method, url] of [
        ['GET', '/api/tasks'],
        ['POST', '/api/tasks'],
        ['GET', `/api/tasks/${id}`],
        ['PATCH', `/api/tasks/${id}`],
        ['DELETE', `/api/tasks/${id}`],
      ] as const) {
        const res = await anon.request(method, url, { body: {}, csrf: false });
        expect([method, url, res.statusCode]).toEqual([method, url, 401]);
      }
    });

    it('needs the CSRF token on every change', async () => {
      const created = await createTask(onceBody);
      const url = `/api/tasks/${created['id']}`;

      expect((await admin.post('/api/tasks', onceBody, { csrf: false })).statusCode).toBe(403);
      expect((await admin.patch(url, { title: 'x' }, { csrf: false })).statusCode).toBe(403);
      expect((await admin.delete(url, { csrf: false })).statusCode).toBe(403);
      expect((await admin.delete(url, { csrf: 'wrong' })).statusCode).toBe(403);
      expect((await admin.get(url)).json<Json>().task.title).toBe(onceBody.title);
    });

    it('lets any member of the household see and edit its tasks', async () => {
      const sam = await addMember(app, admin);
      const created = await createTask(onceBody);

      expect((await sam.client.get(`/api/tasks/${created['id']}`)).statusCode).toBe(200);
      const patched = await sam.client.patch(`/api/tasks/${created['id']}`, { title: 'Bins' });
      expect(patched.statusCode).toBe(200);
      expect((await sam.client.delete(`/api/tasks/${created['id']}`)).statusCode).toBe(204);
    });

    it('answers 404 for another household’s tasks', async () => {
      const outsider = await addOutsider(app, handle);
      const mine = await createTask(onceBody);
      const theirs = await createTask({ ...onceBody, title: 'Theirs' }, outsider.client);
      const url = `/api/tasks/${theirs['id']}`;

      expect((await admin.get(url)).statusCode).toBe(404);
      expect((await admin.patch(url, { title: 'Mine now' })).statusCode).toBe(404);
      expect((await admin.delete(url)).statusCode).toBe(404);
      expect((await admin.get('/api/tasks')).json<Json>().tasks.map((x: Json) => x['id'])).toEqual([
        mine['id'],
      ]);
      expect((await outsider.client.get(url)).json<Json>().task.title).toBe('Theirs');
    });

    it('answers 400 for a malformed id', async () => {
      expect((await admin.get('/api/tasks/nope')).statusCode).toBe(400);
    });
  });

  describe('create', () => {
    it('creates a one-off all-day task with defaults and materialises it', async () => {
      const me = (await admin.get('/api/auth/me')).json<Json>().member;
      const res = await admin.post('/api/tasks', { ...onceBody, title: '  Put the bins out  ' });

      expect(res.statusCode).toBe(201);
      const created = res.json<Json>().task;
      expect(created).toEqual({
        id: expect.any(String),
        title: 'Put the bins out',
        notes: '',
        category: null,
        tags: [],
        priority: 0,
        reminderSlot: 'evening',
        reminderCustomTime: null,
        effortMinutes: null,
        scheduleKind: 'once',
        allDay: true,
        dueDate: '2026-03-05',
        dueAt: null,
        rrule: null,
        intervalAfterCompletionDays: null,
        leadTimeDays: null,
        reminderProfile: 'standard',
        assignmentMode: 'fixed',
        assigneeIds: [],
        nextAssigneeId: null,
        milestones: [],
        archived: false,
        archivedAt: null,
        createdBy: me.id,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });

      // Its occurrence exists straight away, waiting for its day.
      const rows = await occurrencesOf(created['id']);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        dueDate: '2026-03-05',
        status: 'upcoming',
        assigneeId: null,
      });
      expect(await activityKinds()).toContain('task.created');
      const [log] = await handle.db
        .select()
        .from(activity)
        .where(eq(activity.kind, 'task.created'));
      expect(log).toMatchObject({ memberId: me.id, taskId: created['id'] });
    });

    it('creates a task with every field and returns them all', async () => {
      const sam = await addMember(app, admin);
      const me = (await admin.get('/api/auth/me')).json<Json>().member;
      const body = {
        title: 'Clean the oven',
        notes: 'Use the good spray',
        category: 'Kitchen',
        tags: ['deep-clean', 'monthly'],
        priority: 2,
        reminderSlot: 'custom_time',
        reminderCustomTime: '18:30',
        effortMinutes: 45,
        scheduleKind: 'fixed',
        allDay: false,
        dueAt: '2026-03-02T10:00:00+00:00',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        leadTimeDays: 2,
        reminderProfile: 'persistent',
        assignmentMode: 'rotation',
        assigneeIds: [sam.id, me.id],
        milestones: [
          { title: 'Soak the racks', offsetDaysBeforeDue: 1 },
          { title: 'Buy oven cleaner', offsetDaysBeforeDue: 3 },
        ],
      };
      const created = await createTask(body);

      expect(created).toMatchObject({
        ...body,
        dueAt: '2026-03-02T10:00:00.000Z',
        dueDate: null,
        allDay: false,
        milestones: [
          { id: expect.any(String), title: 'Soak the racks', offsetDaysBeforeDue: 1 },
          { id: expect.any(String), title: 'Buy oven cleaner', offsetDaysBeforeDue: 3 },
        ],
      });
      expect((await admin.get(`/api/tasks/${created['id']}`)).json<Json>().task).toEqual(created);

      // Rotation order is kept, and the first assignee gets the occurrences.
      const assignees = await handle.db
        .select()
        .from(taskAssignee)
        .where(eq(taskAssignee.taskId, created['id']))
        .orderBy(asc(taskAssignee.position));
      expect(assignees.map((a) => a.memberId)).toEqual([sam.id, me.id]);
      const rows = await occurrencesOf(created['id']);
      expect(rows.length).toBeGreaterThan(1);
      // The rotation order is kept: Sam first, then the admin, and so on.
      expect(rows.slice(0, 3).map((r) => r.assigneeId)).toEqual([sam.id, me.id, sam.id]);
      expect(created['nextAssigneeId']).toBe(sam.id);
    });

    it('materialises a weekly task over the horizon', async () => {
      const created = await createTask(weeklyBody);
      const rows = await occurrencesOf(created['id']);

      expect(rows).toHaveLength(13);
      expect(rows[0]).toMatchObject({ dueDate: '2026-03-02', status: 'upcoming' });
    });

    it('creates an undated one-off task that is active at once', async () => {
      const created = await createTask({ title: 'Sort the loft', scheduleKind: 'once' });
      expect(created).toMatchObject({ dueDate: null, dueAt: null, allDay: true });
      expect(await occurrencesOf(created['id'])).toMatchObject([
        { dueDate: null, dueAt: null, status: 'active' },
      ]);
    });

    it('uses the household’s default reminder profile when none is given', async () => {
      await handle.db.update(household).set({ defaultReminderProfile: 'gentle' });
      expect((await createTask(onceBody))['reminderProfile']).toBe('gentle');
      expect(
        (await createTask({ ...onceBody, reminderProfile: 'silent' }))['reminderProfile'],
      ).toBe('silent');
    });

    it('stores no custom reminder time unless the slot is custom_time', async () => {
      const created = await createTask({
        ...onceBody,
        reminderSlot: 'morning',
        reminderCustomTime: '07:15',
      });
      expect(created).toMatchObject({ reminderSlot: 'morning', reminderCustomTime: null });
    });

    it('rejects invalid bodies', async () => {
      const invalid: Json[] = [
        {},
        { ...onceBody, title: '   ' },
        { ...onceBody, scheduleKind: 'sometimes' },
        { ...onceBody, dueAt: '2026-03-05T10:00:00Z' },
        { ...onceBody, allDay: false },
        { ...onceBody, dueDate: '2026-02-30' },
        { ...onceBody, rrule: 'FREQ=DAILY' },
        { ...weeklyBody, rrule: undefined },
        { title: 'x', scheduleKind: 'fixed', rrule: 'FREQ=DAILY' },
        { ...onceBody, scheduleKind: 'after_completion' },
        { ...onceBody, reminderSlot: 'custom_time' },
        { ...onceBody, priority: 4 },
        { ...onceBody, tags: ['ok', ''] },
        { ...onceBody, assigneeIds: ['not-a-uuid'] },
      ];
      for (const body of invalid) {
        const res = await admin.post('/api/tasks', body);
        expect([body, res.statusCode]).toEqual([body, 400]);
        expect(res.json()).toMatchObject({ error: 'validation_error' });
      }
      expect(await handle.db.select().from(task)).toHaveLength(0);
    });

    it('rejects a schedule the recurrence engine cannot use', async () => {
      const res = await admin.post('/api/tasks', { ...weeklyBody, rrule: 'FREQ=SOMETIMES' });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_schedule', message: expect.any(String) });
      expect(await handle.db.select().from(task)).toHaveLength(0);
    });

    it('rejects assignees from outside the household and creates nothing', async () => {
      const outsider = await addOutsider(app, handle);
      const sam = await addMember(app, admin);
      for (const assigneeIds of [
        [outsider.memberId],
        [sam.id, outsider.memberId],
        ['00000000-0000-4000-8000-000000000000'],
      ]) {
        const res = await admin.post('/api/tasks', { ...onceBody, assigneeIds });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'invalid_assignee' });
      }
      expect(await handle.db.select().from(task)).toHaveLength(0);
      expect(await handle.db.select().from(occurrence)).toHaveLength(0);
    });
  });

  describe('list and read', () => {
    it('lists active tasks by title, and archived ones on request', async () => {
      await createTask({ ...onceBody, title: 'Water the plants' });
      const archived = await createTask({ ...onceBody, title: 'Old chore' });
      await createTask({ ...onceBody, title: 'Bins' });
      await admin.patch(`/api/tasks/${archived['id']}`, { archived: true });

      const titles = async (query: string) =>
        (await admin.get(`/api/tasks${query}`)).json<Json>().tasks.map((x: Json) => x['title']);
      expect(await titles('')).toEqual(['Bins', 'Water the plants']);
      expect(await titles('?archived=false')).toEqual(['Bins', 'Water the plants']);
      expect(await titles('?archived=true')).toEqual(['Old chore']);
      expect((await admin.get('/api/tasks?archived=maybe')).statusCode).toBe(400);
    });

    it('answers 404 for an unknown task', async () => {
      const res = await admin.get('/api/tasks/00000000-0000-4000-8000-000000000000');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'not_found' });
    });
  });

  describe('update', () => {
    it('changes plain fields without touching the occurrences', async () => {
      const created = await createTask(weeklyBody);
      const before = await occurrencesOf(created['id']);

      const res = await admin.patch(`/api/tasks/${created['id']}`, {
        title: 'Hoover downstairs',
        notes: 'Under the sofa too',
        category: 'Floors',
        tags: ['weekly'],
        priority: 1,
        effortMinutes: 20,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<Json>().task).toMatchObject({
        title: 'Hoover downstairs',
        notes: 'Under the sofa too',
        category: 'Floors',
        tags: ['weekly'],
        priority: 1,
        effortMinutes: 20,
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      });
      expect(await occurrencesOf(created['id'])).toEqual(before);
      const [log] = await handle.db
        .select()
        .from(activity)
        .where(eq(activity.kind, 'task.updated'));
      expect(log?.data).toEqual({
        changed: ['title', 'notes', 'category', 'tags', 'priority', 'effortMinutes'],
      });
    });

    it('clears an optional field with null', async () => {
      const created = await createTask({ ...onceBody, category: 'Outside', effortMinutes: 5 });
      const res = await admin.patch(`/api/tasks/${created['id']}`, {
        category: null,
        effortMinutes: null,
      });
      expect(res.json<Json>().task).toMatchObject({ category: null, effortMinutes: null });
    });

    it('does nothing for an empty patch', async () => {
      const created = await createTask(onceBody);
      const res = await admin.patch(`/api/tasks/${created['id']}`, {});

      expect(res.statusCode).toBe(200);
      expect(res.json<Json>().task).toEqual(created);
      expect(await activityKinds()).toEqual(['task.created']);
    });

    it('re-materialises when the schedule changes, keeping closed and started occurrences', async () => {
      const created = await createTask(weeklyBody);
      const first = (await occurrencesOf(created['id']))[0];
      const second = (await occurrencesOf(created['id']))[1];
      await admin.post(`/api/occurrences/${first?.id}/complete`);
      await admin.post(`/api/occurrences/${second?.id}/start`);

      const res = await admin.patch(`/api/tasks/${created['id']}`, {
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
        dueDate: '2026-03-03',
      });

      expect(res.statusCode).toBe(200);
      const rows = await occurrencesOf(created['id']);
      // The done and started Mondays stay; the rest are Tuesdays from the new start.
      const kept = rows.filter((r) => r.status === 'done' || r.status === 'started');
      expect(kept.map((r) => [r.id, r.dueDate, r.status])).toEqual([
        [first?.id, '2026-03-02', 'done'],
        [second?.id, '2026-03-09', 'started'],
      ]);
      const open = rows.filter((r) => r.status === 'upcoming');
      expect(open.length).toBeGreaterThan(10);
      expect(open[0]).toMatchObject({ dueDate: '2026-03-03' });
      expect(open.map((r) => new Date(`${r.dueDate}T00:00:00Z`).getUTCDay())).toEqual(
        open.map(() => 2),
      );
      const [log] = await handle.db
        .select()
        .from(activity)
        .where(eq(activity.kind, 'task.updated'));
      expect(log?.data).toEqual({ changed: ['dueDate', 'rrule'] });
    });

    it('can turn an all-day task into a timed one', async () => {
      const created = await createTask(onceBody);
      const res = await admin.patch(`/api/tasks/${created['id']}`, {
        allDay: false,
        dueDate: null,
        dueAt: '2026-03-06T09:30:00+00:00',
      });

      expect(res.json<Json>().task).toMatchObject({
        allDay: false,
        dueDate: null,
        dueAt: '2026-03-06T09:30:00.000Z',
      });
      expect(await occurrencesOf(created['id'])).toMatchObject([
        { dueDate: null, dueAt: new Date('2026-03-06T09:30:00Z') },
      ]);
    });

    it('applies lead time to existing occurrences by re-materialising', async () => {
      const created = await createTask(onceBody);
      await admin.patch(`/api/tasks/${created['id']}`, { leadTimeDays: 7 });

      // Due on the 5th with a week of lead time: it has been in view since the 26th.
      expect(await occurrencesOf(created['id'])).toMatchObject([
        { dueDate: '2026-03-05', status: 'active', startAt: expect.any(Date) },
      ]);
    });

    it('rejects a patch whose result is not a valid task, changing nothing', async () => {
      const created = await createTask(weeklyBody);
      const url = `/api/tasks/${created['id']}`;

      // Still has an rrule, which a one-off task must not have.
      const toOnce = await admin.patch(url, { scheduleKind: 'once' });
      expect(toOnce.statusCode).toBe(400);
      expect(toOnce.json()).toMatchObject({ error: 'validation_error' });
      expect(toOnce.json<Json>().message).toContain('rrule');

      for (const bad of [
        { rrule: null },
        { reminderSlot: 'custom_time' },
        { dueDate: null },
        { title: '' },
        { scheduleKind: 'nope' },
        { id: 'x', priority: 9 },
      ]) {
        const res = await admin.patch(url, bad);
        expect([bad, res.statusCode]).toEqual([bad, 400]);
        expect(res.json()).toMatchObject({ error: 'validation_error' });
      }
      expect((await admin.get(url)).json<Json>().task).toEqual(created);
    });

    it('rejects an RRULE the engine cannot use', async () => {
      const created = await createTask(weeklyBody);
      const res = await admin.patch(`/api/tasks/${created['id']}`, { rrule: 'FREQ=SOMETIMES' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_schedule' });
    });

    it('moves from one schedule kind to another', async () => {
      const created = await createTask(weeklyBody);
      const res = await admin.patch(`/api/tasks/${created['id']}`, {
        scheduleKind: 'after_completion',
        rrule: null,
        intervalAfterCompletionDays: 14,
      });

      expect(res.statusCode).toBe(200);
      const rows = await occurrencesOf(created['id']);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dueDate: '2026-03-02' });
    });

    it('drops the custom reminder time when the slot changes', async () => {
      const created = await createTask({
        ...onceBody,
        reminderSlot: 'custom_time',
        reminderCustomTime: '18:30',
      });
      const res = await admin.patch(`/api/tasks/${created['id']}`, { reminderSlot: 'morning' });
      expect(res.json<Json>().task).toMatchObject({
        reminderSlot: 'morning',
        reminderCustomTime: null,
      });
    });

    it('replaces assignees and milestones as whole lists and re-assigns open occurrences', async () => {
      const sam = await addMember(app, admin);
      const me = (await admin.get('/api/auth/me')).json<Json>().member;
      const created = await createTask({
        ...weeklyBody,
        assigneeIds: [me.id],
        milestones: [{ title: 'Charge it', offsetDaysBeforeDue: 1 }],
      });
      const url = `/api/tasks/${created['id']}`;
      const [started] = await occurrencesOf(created['id']);
      await admin.post(`/api/occurrences/${started?.id}/start`);

      const res = await admin.patch(url, {
        assigneeIds: [sam.id, me.id],
        milestones: [
          { title: 'Find the hoover', offsetDaysBeforeDue: 2 },
          { title: 'Empty the bag', offsetDaysBeforeDue: 0 },
        ],
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<Json>().task).toMatchObject({
        assigneeIds: [sam.id, me.id],
        milestones: [
          { title: 'Find the hoover', offsetDaysBeforeDue: 2 },
          { title: 'Empty the bag', offsetDaysBeforeDue: 0 },
        ],
      });
      const rows = await occurrencesOf(created['id']);
      // The started one stays with whoever is doing it.
      expect(rows[0]).toMatchObject({ status: 'started', assigneeId: me.id });
      expect(new Set(rows.slice(1).map((r) => r.assigneeId))).toEqual(new Set([sam.id]));
      expect(rows).toHaveLength(13);

      const cleared = await admin.patch(url, { assigneeIds: [], milestones: [] });
      expect(cleared.json<Json>().task).toMatchObject({ assigneeIds: [], milestones: [] });
      expect(
        new Set((await occurrencesOf(created['id'])).slice(1).map((r) => r.assigneeId)),
      ).toEqual(new Set([null]));
    });

    it('rejects assignees from outside the household', async () => {
      const outsider = await addOutsider(app, handle);
      const created = await createTask(onceBody);
      const res = await admin.patch(`/api/tasks/${created['id']}`, {
        assigneeIds: [outsider.memberId],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_assignee' });
      expect(await handle.db.select().from(taskAssignee)).toHaveLength(0);
    });

    it('archives a task, removing its open occurrences, and restores it', async () => {
      const created = await createTask(weeklyBody);
      const url = `/api/tasks/${created['id']}`;
      const [first] = await occurrencesOf(created['id']);
      await admin.post(`/api/occurrences/${first?.id}/complete`);

      const archived = await admin.patch(url, { archived: true });
      expect(archived.statusCode).toBe(200);
      expect(archived.json<Json>().task).toMatchObject({
        archived: true,
        archivedAt: t.clock.now().toISOString(),
      });
      // Only the finished one is left.
      expect(await occurrencesOf(created['id'])).toMatchObject([{ status: 'done' }]);

      const restored = await admin.patch(url, { archived: false });
      expect(restored.json<Json>().task).toMatchObject({ archived: false, archivedAt: null });
      const rows = await occurrencesOf(created['id']);
      expect(rows).toHaveLength(13);
      expect(rows[0]).toMatchObject({ status: 'done' });
      expect(await activityKinds()).toEqual([
        'task.created',
        'occurrence.completed',
        'task.updated',
        'task.updated',
      ]);
    });

    it('does not materialise a task edited while archived until it is restored', async () => {
      const created = await createTask(onceBody);
      const url = `/api/tasks/${created['id']}`;
      await admin.patch(url, { archived: true });
      await admin.patch(url, { dueDate: '2026-03-09' });
      expect(await occurrencesOf(created['id'])).toHaveLength(0);

      await admin.patch(url, { archived: false });
      expect(await occurrencesOf(created['id'])).toMatchObject([{ dueDate: '2026-03-09' }]);
    });

    it('lets two simultaneous edits take turns', async () => {
      const created = await createTask(onceBody);
      const url = `/api/tasks/${created['id']}`;
      const results = await Promise.all([
        admin.patch(url, { title: 'First' }),
        admin.patch(url, { notes: 'Second' }),
      ]);
      expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
      expect((await admin.get(url)).json<Json>().task).toMatchObject({
        title: 'First',
        notes: 'Second',
      });
    });
  });

  describe('assignment modes', () => {
    /** Names (by member id) of the assignees of a task's occurrences, due first. */
    async function assignedTo(taskId: string, names: Record<string, string>, count = 4) {
      const rows = await occurrencesOf(taskId);
      return rows.slice(0, count).map((r) => (r.assigneeId ? names[r.assigneeId] : null));
    }

    async function rotation() {
      const sam = await addMember(app, admin);
      const me = (await admin.get('/api/auth/me')).json<Json>().member;
      const names = { [me.id]: 'me', [sam.id]: 'sam' };
      return { sam, me, names };
    }

    const cursorOf = async (taskId: string) =>
      (await handle.db.select().from(task).where(eq(task.id, taskId)))[0]?.rotationCursor;

    it('gives a fixed task`s occurrences to its first assignee and any task`s to nobody', async () => {
      const { sam, me, names } = await rotation();
      const fixed = await createTask({ ...weeklyBody, assigneeIds: [sam.id, me.id] });
      const any = await createTask({
        ...weeklyBody,
        assignmentMode: 'any',
        assigneeIds: [sam.id, me.id],
      });

      expect(await assignedTo(fixed['id'], names)).toEqual(['sam', 'sam', 'sam', 'sam']);
      expect(await assignedTo(any['id'], names)).toEqual([null, null, null, null]);
      expect(fixed['nextAssigneeId']).toBe(sam.id);
      expect(any['nextAssigneeId']).toBeNull();
    });

    it('rotates the occurrences of a rotation task through its assignees', async () => {
      const { sam, me, names } = await rotation();
      const created = await createTask({
        ...weeklyBody,
        assignmentMode: 'rotation',
        assigneeIds: [me.id, sam.id],
      });
      expect(await assignedTo(created['id'], names, 5)).toEqual(['me', 'sam', 'me', 'sam', 'me']);
      expect(await cursorOf(created['id'])).toBe(0);
    });

    it('reports the assignee of the earliest open occurrence as nextAssigneeId', async () => {
      const { sam, me } = await rotation();
      const created = await createTask({
        ...weeklyBody,
        assignmentMode: 'rotation',
        assigneeIds: [me.id, sam.id],
      });
      const unassigned = await createTask({ ...weeklyBody, title: 'Nobody' });
      const archivedOnce = await createTask({ ...onceBody, assigneeIds: [sam.id] });
      await admin.patch(`/api/tasks/${archivedOnce['id']}`, { archived: true });

      const list = (await admin.get('/api/tasks')).json<Json>().tasks;
      const next = (id: string) => list.find((x: Json) => x['id'] === id)['nextAssigneeId'];
      expect(next(created['id'])).toBe(me.id);
      expect(next(unassigned['id'])).toBeNull();

      // Once the first is done the next one (Sam's) is the earliest open occurrence.
      const [first] = await occurrencesOf(created['id']);
      await admin.post(`/api/occurrences/${first?.id}/complete`);
      const after = (await admin.get(`/api/tasks/${created['id']}`)).json<Json>().task;
      expect(after['nextAssigneeId']).toBe(sam.id);
    });

    it('has no next assignee once a task has no open occurrences', async () => {
      const { sam } = await rotation();
      const created = await createTask({ ...onceBody, assigneeIds: [sam.id] });
      expect(created['nextAssigneeId']).toBe(sam.id);
      const [only] = await occurrencesOf(created['id']);
      await admin.post(`/api/occurrences/${only?.id}/complete`);
      const after = (await admin.get(`/api/tasks/${created['id']}`)).json<Json>().task;
      expect(after['nextAssigneeId']).toBeNull();
    });

    it('keeps the turn with the same person when the rotation is reordered', async () => {
      const { sam, me, names } = await rotation();
      const created = await createTask({
        ...weeklyBody,
        assignmentMode: 'rotation',
        assigneeIds: [me.id, sam.id],
      });
      const url = `/api/tasks/${created['id']}`;
      const [first] = await occurrencesOf(created['id']);
      await admin.post(`/api/occurrences/${first?.id}/complete`);
      expect(await cursorOf(created['id'])).toBe(1);

      // Sam is next; moving Sam to the front keeps it that way.
      const res = await admin.patch(url, { assigneeIds: [sam.id, me.id] });

      expect(res.json<Json>().task['nextAssigneeId']).toBe(sam.id);
      expect(await cursorOf(created['id'])).toBe(0);
      expect((await assignedTo(created['id'], names, 5)).slice(1)).toEqual([
        'sam',
        'me',
        'sam',
        'me',
      ]);
    });

    it('starts from the first assignee when the one whose turn it was is removed', async () => {
      const { sam, me, names } = await rotation();
      const third = await addMember(app, admin, { name: 'Jo', username: 'jo', email: 'jo@x.com' });
      const created = await createTask({
        ...weeklyBody,
        assignmentMode: 'rotation',
        assigneeIds: [me.id, sam.id, third.id],
      });
      const [first] = await occurrencesOf(created['id']);
      await admin.post(`/api/occurrences/${first?.id}/complete`);
      expect(await cursorOf(created['id'])).toBe(1);

      await admin.patch(`/api/tasks/${created['id']}`, { assigneeIds: [me.id, third.id] });

      expect(await cursorOf(created['id'])).toBe(0);
      const withJo = { ...names, [third.id]: 'jo' };
      expect((await assignedTo(created['id'], withJo, 3)).slice(1)).toEqual(['me', 'jo']);
    });

    it('starts the rotation from the first assignee when the mode changes to it', async () => {
      const { sam, me, names } = await rotation();
      const created = await createTask({ ...weeklyBody, assigneeIds: [sam.id, me.id] });
      const url = `/api/tasks/${created['id']}`;

      const res = await admin.patch(url, { assignmentMode: 'rotation' });
      expect(res.statusCode).toBe(200);
      expect(await assignedTo(created['id'], names)).toEqual(['sam', 'me', 'sam', 'me']);

      await admin.patch(url, { assignmentMode: 'any' });
      expect(await assignedTo(created['id'], names)).toEqual([null, null, null, null]);
      expect(await cursorOf(created['id'])).toBe(0);

      await admin.patch(url, { assignmentMode: 'fixed' });
      expect(await assignedTo(created['id'], names)).toEqual(['sam', 'sam', 'sam', 'sam']);
    });

    it('re-plans after a schedule change', async () => {
      const { sam, me, names } = await rotation();
      const created = await createTask({
        ...weeklyBody,
        assignmentMode: 'rotation',
        assigneeIds: [me.id, sam.id],
      });

      await admin.patch(`/api/tasks/${created['id']}`, { rrule: 'FREQ=WEEKLY;BYDAY=TU' });

      expect(await assignedTo(created['id'], names, 4)).toEqual(['me', 'sam', 'me', 'sam']);
    });
  });

  describe('delete', () => {
    it('removes the task and everything hanging off it, and logs it', async () => {
      const sam = await addMember(app, admin);
      const created = await createTask({
        ...weeklyBody,
        assigneeIds: [sam.id],
        milestones: [{ title: 'Plug in', offsetDaysBeforeDue: 1 }],
      });
      const [first] = await occurrencesOf(created['id']);
      await admin.post(`/api/occurrences/${first?.id}/complete`);

      const res = await admin.delete(`/api/tasks/${created['id']}`);

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(await handle.db.select().from(task)).toHaveLength(0);
      expect(await handle.db.select().from(occurrence)).toHaveLength(0);
      expect(await handle.db.select().from(taskAssignee)).toHaveLength(0);
      const [log] = await handle.db
        .select()
        .from(activity)
        .where(eq(activity.kind, 'task.deleted'));
      expect(log).toMatchObject({
        taskId: null,
        data: { taskId: created['id'], title: 'Hoover' },
      });
      expect((await admin.get(`/api/tasks/${created['id']}`)).statusCode).toBe(404);
      expect((await admin.delete(`/api/tasks/${created['id']}`)).statusCode).toBe(404);
    });
  });
});
