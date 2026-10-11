import { activity, occurrence, task, type DbHandle } from '@tracker/db';
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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// The test clock starts at 2026-03-01T12:00:00Z, a Sunday; the household is on London time (GMT).
describe.skipIf(!adminUrl)('occurrences (integration)', () => {
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

  async function createTask(body: Json, client: TestClient = admin): Promise<Json> {
    const res = await client.post('/api/tasks', { scheduleKind: 'once', ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Json>().task;
  }

  /** The id of a task's first (earliest) occurrence. */
  async function firstOccurrence(taskId: string): Promise<Json> {
    const res = await admin.get(`/api/occurrences?view=upcoming&days=366&taskId=${taskId}`);
    const today = await admin.get(`/api/occurrences?taskId=${taskId}`);
    const all = [...today.json<Json>().occurrences, ...res.json<Json>().occurrences];
    expect(all.length).toBeGreaterThan(0);
    return all[0];
  }

  async function list(query = '', client: TestClient = admin): Promise<string[]> {
    const res = await client.get(`/api/occurrences${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Json>().occurrences.map((o: Json) => o['task'].title);
  }

  const kinds = async () =>
    (await handle.db.select().from(activity).orderBy(asc(activity.createdAt))).map((a) => a.kind);

  describe('access', () => {
    it('needs a session on every route', async () => {
      const anon = new TestClient(app);
      const id = '00000000-0000-4000-8000-000000000000';
      for (const [method, url] of [
        ['GET', '/api/occurrences'],
        ['GET', `/api/occurrences/${id}`],
        ['POST', `/api/occurrences/${id}/complete`],
        ['POST', `/api/occurrences/${id}/skip`],
        ['POST', `/api/occurrences/${id}/snooze`],
        ['POST', `/api/occurrences/${id}/start`],
      ] as const) {
        const res = await anon.request(method, url, { body: {}, csrf: false });
        expect([method, url, res.statusCode]).toEqual([method, url, 401]);
      }
    });

    it('needs the CSRF token on every action', async () => {
      const created = await createTask({ title: 'Bins', dueDate: '2026-03-01' });
      const occ = await firstOccurrence(created['id']);
      for (const action of ['complete', 'skip', 'snooze', 'start']) {
        const res = await admin.post(
          `/api/occurrences/${occ['id']}/${action}`,
          { days: 1 },
          { csrf: false },
        );
        expect([action, res.statusCode]).toEqual([action, 403]);
      }
      expect(
        (await admin.get(`/api/occurrences/${occ['id']}`)).json<Json>().occurrence.status,
      ).toBe('active');
    });

    it('answers 404 for another household’s occurrences', async () => {
      const outsider = await addOutsider(app, handle);
      const theirs = await createTask({ title: 'Theirs', dueDate: '2026-03-01' }, outsider.client);
      const occ = (await outsider.client.get('/api/occurrences')).json<Json>().occurrences[0];

      expect(await list('', admin)).toEqual([]);
      expect(await list(`?taskId=${theirs['id']}`, admin)).toEqual([]);
      expect((await admin.get(`/api/occurrences/${occ['id']}`)).statusCode).toBe(404);
      for (const action of ['complete', 'skip', 'snooze', 'start']) {
        const res = await admin.post(`/api/occurrences/${occ['id']}/${action}`, { days: 1 });
        expect([action, res.statusCode]).toEqual([action, 404]);
      }
      expect((await outsider.client.get(`/api/occurrences/${occ['id']}`)).statusCode).toBe(200);
      expect(
        (await handle.db.select().from(occurrence).where(eq(occurrence.id, occ['id'])))[0]?.status,
      ).toBe('active');
    });

    it('lets any member of the household act on its occurrences', async () => {
      const sam = await addMember(app, admin);
      const created = await createTask({ title: 'Bins', dueDate: '2026-03-01' });
      const occ = await firstOccurrence(created['id']);

      const res = await sam.client.post(`/api/occurrences/${occ['id']}/complete`);
      expect(res.statusCode).toBe(200);
      expect(res.json<Json>().occurrence).toMatchObject({ status: 'done', completedBy: sam.id });
    });

    it('validates ids and the query', async () => {
      expect((await admin.get('/api/occurrences/nope')).statusCode).toBe(400);
      for (const query of [
        'view=tomorrow',
        'days=0',
        'days=367',
        'limit=0',
        'limit=501',
        'memberId=x',
      ]) {
        const res = await admin.get(`/api/occurrences?${query}`);
        expect([query, res.statusCode]).toEqual([query, 400]);
      }
    });
  });

  describe('views', () => {
    /** A spread of tasks around "now" (Sunday 1 March 2026, 12:00). */
    async function seed() {
      await createTask({ title: 'A overdue all-day', dueDate: '2026-02-27' });
      await createTask({ title: 'B due today', dueDate: '2026-03-01' });
      await createTask({ title: 'C overdue timed', allDay: false, dueAt: '2026-03-01T09:00:00Z' });
      await createTask({ title: 'D later today', allDay: false, dueAt: '2026-03-01T18:00:00Z' });
      await createTask({ title: 'E undated' });
      await createTask({ title: 'F tomorrow', dueDate: '2026-03-02' });
      await createTask({ title: 'G in six weeks', dueDate: '2026-04-15' });
      await createTask({ title: 'H lead time', dueDate: '2026-03-03', leadTimeDays: 3 });
    }

    it('today: overdue first, then by due, undated last, including lead-time starts', async () => {
      await seed();
      expect(await list()).toEqual([
        'A overdue all-day',
        'C overdue timed',
        'B due today',
        'D later today',
        'H lead time',
        'E undated',
      ]);
      expect(await list('?view=today')).toEqual(await list());
    });

    it('overdue: only what is past due, oldest first', async () => {
      await seed();
      expect(await list('?view=overdue')).toEqual(['A overdue all-day', 'C overdue timed']);
    });

    it('upcoming: from tomorrow up to `days` ahead', async () => {
      await seed();
      expect(await list('?view=upcoming')).toEqual(['F tomorrow', 'H lead time']);
      expect(await list('?view=upcoming&days=1')).toEqual(['F tomorrow']);
      expect(await list('?view=upcoming&days=60')).toEqual([
        'F tomorrow',
        'H lead time',
        'G in six weeks',
      ]);
    });

    it('upcoming: includes an occurrence whose lead time starts within the window', async () => {
      // Due in a month, but it starts showing in three days.
      await createTask({ title: 'Book MOT', dueDate: '2026-04-01', leadTimeDays: 28 });
      expect(await list('?view=upcoming&days=3')).toEqual(['Book MOT']);
      expect(await list('?view=upcoming&days=30')).toEqual(['Book MOT']);
      expect(await list('?view=upcoming&days=2')).toEqual([]);
    });

    it('flags overdue occurrences in the response', async () => {
      await seed();
      const res = await admin.get('/api/occurrences');
      const overdue = Object.fromEntries(
        res.json<Json>().occurrences.map((o: Json) => [o['task'].title, o['overdue']]),
      );
      expect(overdue).toEqual({
        'A overdue all-day': true,
        'B due today': false,
        'C overdue timed': true,
        'D later today': false,
        'H lead time': false,
        'E undated': false,
      });
    });

    it('returns the occurrence and task fields', async () => {
      const created = await createTask({
        title: 'Bins',
        category: 'Outside',
        priority: 2,
        dueDate: '2026-03-01',
      });
      const [occ] = (await admin.get('/api/occurrences')).json<Json>().occurrences;

      expect(occ).toEqual({
        id: expect.any(String),
        taskId: created['id'],
        task: {
          title: 'Bins',
          category: 'Outside',
          priority: 2,
          allDay: true,
          scheduleKind: 'once',
        },
        dueDate: '2026-03-01',
        dueAt: null,
        startAt: null,
        assigneeId: null,
        status: 'active',
        completedAt: null,
        completedBy: null,
        snoozedUntil: null,
        overdue: false,
      });
      expect((await admin.get(`/api/occurrences/${occ['id']}`)).json()).toEqual({
        occurrence: occ,
      });
    });

    it('uses the household’s local day around the BST change', async () => {
      // 00:30 on 1 July in London, still 30 June in UTC.
      t.clock.set('2026-06-30T23:30:00Z');
      await createTask({ title: 'Due 30 June', dueDate: '2026-06-30' });
      await createTask({ title: 'Due 1 July', dueDate: '2026-07-01' });
      await createTask({ title: 'Due 2 July', dueDate: '2026-07-02' });
      // 23:30 BST on 1 July is today; 00:30 BST on 2 July is tomorrow (both 1 July in UTC).
      await createTask({ title: 'Late tonight', allDay: false, dueAt: '2026-07-01T22:30:00Z' });
      await createTask({
        title: 'Just after midnight',
        allDay: false,
        dueAt: '2026-07-01T23:30:00Z',
      });

      expect(await list('?view=today')).toEqual(['Due 30 June', 'Due 1 July', 'Late tonight']);
      expect(await list('?view=overdue')).toEqual(['Due 30 June']);
      expect(await list('?view=upcoming&days=7')).toEqual(['Due 2 July', 'Just after midnight']);
    });

    it('treats clocks going forward as a 23-hour day', async () => {
      // Sunday 29 March 2026: London moves from GMT to BST at 01:00 UTC.
      t.clock.set('2026-03-29T10:00:00Z');
      await createTask({ title: 'Evening 29th', allDay: false, dueAt: '2026-03-29T22:30:00Z' });
      await createTask({
        title: 'Tomorrow 00:30 BST',
        allDay: false,
        dueAt: '2026-03-29T23:30:00Z',
      });
      expect(await list('?view=today')).toEqual(['Evening 29th']);
      expect(await list('?view=upcoming')).toEqual(['Tomorrow 00:30 BST']);
    });

    it('filters by assigned member and by task', async () => {
      const sam = await addMember(app, admin);
      const me = (await admin.get('/api/auth/me')).json<Json>().member;
      const mine = await createTask({ title: 'Mine', dueDate: '2026-03-01', assigneeIds: [me.id] });
      await createTask({ title: 'Sams', dueDate: '2026-03-01', assigneeIds: [sam.id] });
      await createTask({
        title: 'Anyone',
        dueDate: '2026-03-01',
        assignmentMode: 'any',
        assigneeIds: [sam.id, me.id],
      });

      expect((await list()).sort()).toEqual(['Anyone', 'Mine', 'Sams']);
      expect(await list(`?memberId=${me.id}`)).toEqual(['Mine']);
      expect(await list(`?memberId=${sam.id}`)).toEqual(['Sams']);
      expect(await list(`?taskId=${mine['id']}`)).toEqual(['Mine']);
      expect(await list(`?taskId=${mine['id']}&memberId=${sam.id}`)).toEqual([]);
    });

    it('limits the number of results', async () => {
      for (const n of [1, 2, 3]) await createTask({ title: `T${n}`, dueDate: `2026-03-0${n}` });
      expect(await list('?view=upcoming&limit=1')).toEqual(['T2']);
      expect(await list('?view=upcoming&limit=2')).toEqual(['T2', 'T3']);
    });

    it('leaves out done, skipped and archived occurrences but keeps started ones', async () => {
      const done = await createTask({ title: 'Done', dueDate: '2026-03-01' });
      const skipped = await createTask({ title: 'Skipped', dueDate: '2026-03-01' });
      const started = await createTask({ title: 'Started', dueDate: '2026-03-01' });
      const archived = await createTask({ title: 'Archived', dueDate: '2026-03-01' });
      await createTask({ title: 'Open', dueDate: '2026-03-01' });
      const id = async (task: Json) => (await firstOccurrence(task['id']))['id'];
      await admin.post(`/api/occurrences/${await id(done)}/complete`);
      await admin.post(`/api/occurrences/${await id(skipped)}/skip`);
      await admin.post(`/api/occurrences/${await id(started)}/start`);
      await admin.patch(`/api/tasks/${archived['id']}`, { archived: true });

      expect((await list()).sort()).toEqual(['Open', 'Started']);
    });
  });

  describe('complete and skip', () => {
    it('completes an occurrence and logs it', async () => {
      const created = await createTask({ title: 'Bins', dueDate: '2026-03-01' });
      const occ = await firstOccurrence(created['id']);
      const me = (await admin.get('/api/auth/me')).json<Json>().member;
      t.clock.advance(2 * HOUR);

      const res = await admin.post(`/api/occurrences/${occ['id']}/complete`);

      expect(res.statusCode).toBe(200);
      expect(res.json<Json>()).toEqual({
        occurrence: {
          ...occ,
          status: 'done',
          completedAt: t.clock.now().toISOString(),
          completedBy: me.id,
        },
        next: null,
      });
      expect(await list()).toEqual([]);
      const [log] = await handle.db
        .select()
        .from(activity)
        .where(eq(activity.kind, 'occurrence.completed'));
      expect(log).toMatchObject({
        memberId: me.id,
        taskId: created['id'],
        occurrenceId: occ['id'],
        data: { title: 'Bins' },
      });
    });

    it('ends a snooze when completing', async () => {
      const created = await createTask({ title: 'Bins', dueDate: '2026-03-01' });
      const occ = await firstOccurrence(created['id']);
      await admin.post(`/api/occurrences/${occ['id']}/snooze`, { days: 2 });

      const res = await admin.post(`/api/occurrences/${occ['id']}/complete`);
      expect(res.json<Json>().occurrence).toMatchObject({ status: 'done', snoozedUntil: null });
    });

    it('skips an occurrence', async () => {
      const created = await createTask({ title: 'Bins', dueDate: '2026-03-01' });
      const occ = await firstOccurrence(created['id']);

      const res = await admin.post(`/api/occurrences/${occ['id']}/skip`);

      expect(res.statusCode).toBe(200);
      expect(res.json<Json>().occurrence).toMatchObject({
        status: 'skipped',
        completedAt: t.clock.now().toISOString(),
      });
      expect(res.json<Json>().next).toBeNull();
      expect(await kinds()).toEqual(['task.created', 'occurrence.skipped']);
    });

    it('answers 409 for an occurrence that is already done or skipped', async () => {
      const created = await createTask({ title: 'Bins', dueDate: '2026-03-01' });
      const occ = await firstOccurrence(created['id']);
      await admin.post(`/api/occurrences/${occ['id']}/complete`);
      const other = await createTask({ title: 'Mop', dueDate: '2026-03-01' });
      const otherOcc = await firstOccurrence(other['id']);
      await admin.post(`/api/occurrences/${otherOcc['id']}/skip`);

      for (const id of [occ['id'], otherOcc['id']]) {
        for (const action of ['complete', 'skip', 'snooze', 'start']) {
          const res = await admin.post(`/api/occurrences/${id}/${action}`, { days: 1 });
          expect([action, res.statusCode]).toEqual([action, 409]);
          expect(res.json()).toMatchObject({ error: 'occurrence_closed' });
        }
      }
      expect((await kinds()).filter((k) => k.startsWith('occurrence.'))).toEqual([
        'occurrence.completed',
        'occurrence.skipped',
      ]);
    });

    it('lets exactly one of two simultaneous completions win', async () => {
      const created = await createTask({
        title: 'Water',
        scheduleKind: 'after_completion',
        intervalAfterCompletionDays: 3,
        dueDate: '2026-03-01',
      });
      const occ = await firstOccurrence(created['id']);

      const results = await Promise.all(
        [1, 2, 3].map(() => admin.post(`/api/occurrences/${occ['id']}/complete`)),
      );

      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
      expect((await kinds()).filter((k) => k === 'occurrence.completed')).toHaveLength(1);
      // Only the winner scheduled a follow-up.
      expect(
        await handle.db.select().from(occurrence).where(eq(occurrence.taskId, created['id'])),
      ).toHaveLength(2);
    });

    it('completing an after_completion occurrence creates the next one from the completion', async () => {
      const created = await createTask({
        title: 'Change the filter',
        scheduleKind: 'after_completion',
        intervalAfterCompletionDays: 7,
        dueDate: '2026-02-26',
      });
      const occ = await firstOccurrence(created['id']);
      expect(occ).toMatchObject({ dueDate: '2026-02-26', overdue: true });

      const res = await admin.post(`/api/occurrences/${occ['id']}/complete`);

      const body = res.json<Json>();
      expect(body.occurrence.status).toBe('done');
      // Seven days after finishing it today, not after it was due.
      expect(body.next).toMatchObject({
        taskId: created['id'],
        dueDate: '2026-03-08',
        status: 'upcoming',
        overdue: false,
        completedAt: null,
      });
      expect(body.next.id).not.toBe(occ['id']);
      expect((await admin.get(`/api/occurrences/${body.next.id}`)).json()).toEqual({
        occurrence: body.next,
      });
      const rows = await handle.db
        .select()
        .from(occurrence)
        .where(eq(occurrence.taskId, created['id']));
      expect(rows.map((r) => r.status).sort()).toEqual(['done', 'upcoming']);
    });

    it('skipping an after_completion occurrence also moves on', async () => {
      const created = await createTask({
        title: 'Change the filter',
        scheduleKind: 'after_completion',
        intervalAfterCompletionDays: 7,
        dueDate: '2026-03-01',
      });
      const occ = await firstOccurrence(created['id']);
      const res = await admin.post(`/api/occurrences/${occ['id']}/skip`);
      expect(res.json<Json>().next).toMatchObject({ dueDate: '2026-03-08' });
    });

    it('creates no follow-up for an archived task', async () => {
      const created = await createTask({
        title: 'Change the filter',
        scheduleKind: 'after_completion',
        intervalAfterCompletionDays: 7,
        dueDate: '2026-03-01',
      });
      const occ = await firstOccurrence(created['id']);
      // Archiving removes the open occurrence; start it first so it survives.
      await admin.post(`/api/occurrences/${occ['id']}/start`);
      await admin.patch(`/api/tasks/${created['id']}`, { archived: true });

      const res = await admin.post(`/api/occurrences/${occ['id']}/complete`);
      expect(res.json<Json>().next).toBeNull();
    });

    it('completing one occurrence of a weekly task leaves the others alone', async () => {
      const created = await createTask({
        title: 'Hoover',
        scheduleKind: 'fixed',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        dueDate: '2026-03-02',
      });
      const rows = await handle.db
        .select()
        .from(occurrence)
        .where(eq(occurrence.taskId, created['id']))
        .orderBy(asc(occurrence.dueDate));
      const res = await admin.post(`/api/occurrences/${rows[0]?.id}/complete`);

      expect(res.json<Json>().next).toBeNull();
      expect(
        await handle.db.select().from(occurrence).where(eq(occurrence.taskId, created['id'])),
      ).toHaveLength(rows.length);
    });
  });

  describe('snooze', () => {
    it('hides an occurrence until the given time, then it returns', async () => {
      const created = await createTask({ title: 'Bins', dueDate: '2026-02-28' });
      const occ = await firstOccurrence(created['id']);
      const until = new Date(t.clock.now().getTime() + 3 * HOUR).toISOString();

      const res = await admin.post(`/api/occurrences/${occ['id']}/snooze`, { until });

      expect(res.statusCode).toBe(200);
      expect(res.json<Json>().occurrence).toMatchObject({
        id: occ['id'],
        status: 'active',
        snoozedUntil: until,
        overdue: true,
      });
      expect(await list()).toEqual([]);
      expect(await list('?view=overdue')).toEqual([]);

      t.clock.advance(3 * HOUR);
      expect(await list()).toEqual(['Bins']);
      expect(await list('?view=overdue')).toEqual(['Bins']);
      const [log] = await handle.db
        .select()
        .from(activity)
        .where(eq(activity.kind, 'occurrence.snoozed'));
      expect(log?.data).toEqual({ title: 'Bins', until });
    });

    it('snoozes for a number of days', async () => {
      const created = await createTask({ title: 'Bins', dueDate: '2026-03-01' });
      const occ = await firstOccurrence(created['id']);

      const res = await admin.post(`/api/occurrences/${occ['id']}/snooze`, { days: 2 });

      expect(res.json<Json>().occurrence.snoozedUntil).toBe(
        new Date(t.clock.now().getTime() + 2 * DAY).toISOString(),
      );
      expect(await list()).toEqual([]);
      t.clock.advance(2 * DAY);
      expect(await list()).toEqual(['Bins']);
    });

    it('can be snoozed again, and a started occurrence can be snoozed', async () => {
      const created = await createTask({ title: 'Bins', dueDate: '2026-03-01' });
      const occ = await firstOccurrence(created['id']);
      await admin.post(`/api/occurrences/${occ['id']}/start`);
      await admin.post(`/api/occurrences/${occ['id']}/snooze`, { days: 1 });
      const res = await admin.post(`/api/occurrences/${occ['id']}/snooze`, { days: 5 });
      expect(res.json<Json>().occurrence).toMatchObject({
        status: 'started',
        snoozedUntil: new Date(t.clock.now().getTime() + 5 * DAY).toISOString(),
      });
    });

    it('rejects a time that is not in the future', async () => {
      const created = await createTask({ title: 'Bins', dueDate: '2026-03-01' });
      const occ = await firstOccurrence(created['id']);
      for (const until of [t.clock.now().toISOString(), '2026-02-01T00:00:00Z']) {
        const res = await admin.post(`/api/occurrences/${occ['id']}/snooze`, { until });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'invalid_snooze' });
      }
      expect(await list()).toEqual(['Bins']);
    });

    it('rejects bad bodies', async () => {
      const created = await createTask({ title: 'Bins', dueDate: '2026-03-01' });
      const occ = await firstOccurrence(created['id']);
      for (const body of [
        {},
        { days: 0 },
        { days: 366 },
        { days: 1.5 },
        { until: 'tomorrow' },
        { days: 1, until: '2026-03-05T00:00:00Z' },
      ]) {
        const res = await admin.post(`/api/occurrences/${occ['id']}/snooze`, body);
        expect([body, res.statusCode]).toEqual([body, 400]);
        expect(res.json()).toMatchObject({ error: 'validation_error' });
      }
    });
  });

  describe('start', () => {
    it('starts an upcoming or active occurrence and ends a snooze', async () => {
      const upcoming = await createTask({ title: 'Later', dueDate: '2026-03-20' });
      const upcomingOcc = await firstOccurrence(upcoming['id']);
      expect(upcomingOcc['status']).toBe('upcoming');
      const active = await createTask({ title: 'Now', dueDate: '2026-03-01' });
      const activeOcc = await firstOccurrence(active['id']);
      await admin.post(`/api/occurrences/${activeOcc['id']}/snooze`, { days: 1 });

      for (const occ of [upcomingOcc, activeOcc]) {
        const res = await admin.post(`/api/occurrences/${occ['id']}/start`);
        expect(res.statusCode).toBe(200);
        expect(res.json<Json>().occurrence).toMatchObject({
          id: occ['id'],
          status: 'started',
          snoozedUntil: null,
        });
      }
      expect(await list()).toEqual(['Now']);
    });

    it('is a no-op for an occurrence that is already started', async () => {
      const created = await createTask({ title: 'Bins', dueDate: '2026-03-01' });
      const occ = await firstOccurrence(created['id']);
      const first = await admin.post(`/api/occurrences/${occ['id']}/start`);
      t.clock.advance(HOUR);
      const again = await admin.post(`/api/occurrences/${occ['id']}/start`);

      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(first.json());
      expect((await kinds()).filter((k) => k === 'occurrence.started')).toHaveLength(1);
    });

    it('can still be completed once started', async () => {
      const created = await createTask({ title: 'Bins', dueDate: '2026-03-01' });
      const occ = await firstOccurrence(created['id']);
      await admin.post(`/api/occurrences/${occ['id']}/start`);
      const res = await admin.post(`/api/occurrences/${occ['id']}/complete`);
      expect(res.json<Json>().occurrence.status).toBe('done');
    });
  });

  describe('rotation', () => {
    async function setUp() {
      const sam = await addMember(app, admin);
      const me = (await admin.get('/api/auth/me')).json<Json>().member;
      const created = await createTask({
        title: 'Hoover',
        scheduleKind: 'fixed',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        dueDate: '2026-03-02',
        assignmentMode: 'rotation',
        assigneeIds: [me.id, sam.id],
      });
      const names = { [me.id]: 'me', [sam.id]: 'sam' };
      return { sam, me, taskId: created['id'] as string, names };
    }

    const rowsOf = (taskId: string) =>
      handle.db
        .select()
        .from(occurrence)
        .where(eq(occurrence.taskId, taskId))
        .orderBy(asc(occurrence.dueDate));
    const who = async (taskId: string, names: Record<string, string>, count = 5) =>
      (await rowsOf(taskId))
        .filter((r) => r.status === 'upcoming' || r.status === 'active')
        .slice(0, count)
        .map((r) => (r.assigneeId ? names[r.assigneeId] : null));
    const cursorOf = async (taskId: string) =>
      (await handle.db.select().from(task).where(eq(task.id, taskId)))[0]?.rotationCursor;

    it('advances the rotation when an occurrence is completed or skipped', async () => {
      const { taskId, names } = await setUp();
      expect(await who(taskId, names, 4)).toEqual(['me', 'sam', 'me', 'sam']);
      const [first, second] = await rowsOf(taskId);

      expect((await admin.post(`/api/occurrences/${first?.id}/complete`)).statusCode).toBe(200);
      expect(await cursorOf(taskId)).toBe(1);
      expect((await admin.post(`/api/occurrences/${second?.id}/skip`)).statusCode).toBe(200);
      expect(await cursorOf(taskId)).toBe(0);

      expect(await who(taskId, names, 4)).toEqual(['me', 'sam', 'me', 'sam']);
    });

    it('uses up the assignee`s turn even when someone else does the job', async () => {
      const { sam, taskId, names } = await setUp();
      const [first] = await rowsOf(taskId);

      const res = await sam.client.post(`/api/occurrences/${first?.id}/complete`);

      expect(res.json<Json>().occurrence).toMatchObject({ assigneeId: first?.assigneeId });
      expect((await rowsOf(taskId))[0]).toMatchObject({ status: 'done', completedBy: sam.id });
      expect(await cursorOf(taskId)).toBe(1);
      expect(await who(taskId, names, 3)).toEqual(['sam', 'me', 'sam']);
    });

    it('uses the turn up when an occurrence is started, but only once', async () => {
      const { taskId, names } = await setUp();
      const [first] = await rowsOf(taskId);

      await admin.post(`/api/occurrences/${first?.id}/start`);
      expect(await cursorOf(taskId)).toBe(1);
      await admin.post(`/api/occurrences/${first?.id}/start`);
      expect(await cursorOf(taskId)).toBe(1);
      await admin.post(`/api/occurrences/${first?.id}/complete`);
      expect(await cursorOf(taskId)).toBe(1);

      // A second occurrence that is completed after being started does not advance twice.
      const second = (await rowsOf(taskId))[1];
      await admin.post(`/api/occurrences/${second?.id}/start`);
      await admin.post(`/api/occurrences/${second?.id}/complete`);
      expect(await cursorOf(taskId)).toBe(0);
      expect(await who(taskId, names, 2)).toEqual(['me', 'sam']);
    });

    it('does not advance when the action is refused', async () => {
      const { taskId } = await setUp();
      const [first] = await rowsOf(taskId);
      await admin.post(`/api/occurrences/${first?.id}/complete`);

      expect((await admin.post(`/api/occurrences/${first?.id}/complete`)).statusCode).toBe(409);
      expect((await admin.post(`/api/occurrences/${first?.id}/skip`)).statusCode).toBe(409);

      expect(await cursorOf(taskId)).toBe(1);
    });

    it('does not move the rotation for a snooze', async () => {
      const { taskId } = await setUp();
      const [first] = await rowsOf(taskId);
      await admin.post(`/api/occurrences/${first?.id}/snooze`, { days: 2 });
      expect(await cursorOf(taskId)).toBe(0);
    });

    it('hands the next after_completion occurrence to the next person', async () => {
      const sam = await addMember(app, admin);
      const me = (await admin.get('/api/auth/me')).json<Json>().member;
      const created = await createTask({
        title: 'Water the plants',
        scheduleKind: 'after_completion',
        intervalAfterCompletionDays: 7,
        dueDate: '2026-03-01',
        assignmentMode: 'rotation',
        assigneeIds: [me.id, sam.id],
      });
      const first = await firstOccurrence(created['id']);
      expect(first['assigneeId']).toBe(me.id);

      const res = await admin.post(`/api/occurrences/${first['id']}/complete`);
      expect(res.json<Json>().next).toMatchObject({ assigneeId: sam.id });

      const next = res.json<Json>().next;
      // The follow-up is due a week after the completion, so complete the second one later.
      t.clock.advance(DAY);
      const again = await admin.post(`/api/occurrences/${next['id']}/complete`);
      expect(again.json<Json>().next).toMatchObject({ assigneeId: me.id });
    });

    it('leaves fixed and any tasks alone', async () => {
      const sam = await addMember(app, admin);
      const created = await createTask({
        title: 'Bins',
        scheduleKind: 'fixed',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        dueDate: '2026-03-02',
        assigneeIds: [sam.id],
      });
      const [first] = await handle.db
        .select()
        .from(occurrence)
        .where(eq(occurrence.taskId, created['id']))
        .orderBy(asc(occurrence.dueDate));
      await admin.post(`/api/occurrences/${first?.id}/complete`);
      expect(
        (await handle.db.select().from(task).where(eq(task.id, created['id'])))[0]?.rotationCursor,
      ).toBe(0);
    });
  });

  describe('lifecycle', () => {
    it('removes occurrences when their task is deleted', async () => {
      const created = await createTask({ title: 'Bins', dueDate: '2026-03-01' });
      const occ = await firstOccurrence(created['id']);
      await admin.delete(`/api/tasks/${created['id']}`);

      expect((await admin.get(`/api/occurrences/${occ['id']}`)).statusCode).toBe(404);
      expect(await handle.db.select().from(task)).toHaveLength(0);
    });
  });
});
