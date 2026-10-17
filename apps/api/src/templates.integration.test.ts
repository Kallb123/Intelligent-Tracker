import { occurrence, type DbHandle } from '@tracker/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addOutsider,
  createMigratedDatabase,
  createTestApp,
  setUpAdmin,
  TestClient,
  type TestApp,
} from './test-util.js';

const adminUrl = process.env['TEST_DATABASE_URL'];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!adminUrl)('templates (integration)', () => {
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let handle: DbHandle;
  let t: TestApp;
  let admin: TestClient;
  const body = {
    title: 'Water plants',
    keywords: ['plants'],
    defaults: {
      scheduleKind: 'after_completion',
      intervalAfterCompletionDays: 7,
      leadTimeDays: 2,
      milestones: [{ title: 'Check soil', offsetDaysBeforeDue: 1 }],
    },
  };
  beforeAll(async () => {
    database = await createMigratedDatabase(adminUrl!);
    handle = database.handle;
  });
  afterAll(() => database?.close());
  beforeEach(async () => {
    await t?.app.close();
    await handle.sql`truncate household cascade`;
    t = createTestApp(handle);
    admin = await setUpAdmin(t.app);
  });
  afterAll(() => t?.app.close());

  it('requires login, CSRF, and keeps built-ins read-only', async () => {
    const anon = new TestClient(t.app);
    expect((await anon.get('/api/templates')).statusCode).toBe(401);
    expect((await anon.get('/api/bank-holidays')).statusCode).toBe(401);
    expect((await admin.post('/api/templates', body, { csrf: false })).statusCode).toBe(403);
    expect((await admin.delete('/api/templates/mot')).statusCode).toBe(400);
  });
  it('creates, reads, replaces, and deletes household templates with milestones', async () => {
    const created = await admin.post('/api/templates', body);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<Json>().template.id;
    const list = (await admin.get('/api/templates')).json<Json>().templates;
    expect(list.find((t: Json) => t.id === id)).toMatchObject({ ...body, builtIn: false });
    expect(list.find((t: Json) => t.id === 'car-insurance').defaults.milestones).toHaveLength(3);
    expect(
      (await admin.patch(`/api/templates/${id}`, { ...body, title: 'Water herbs' })).statusCode,
    ).toBe(200);
    expect((await admin.delete(`/api/templates/${id}`)).statusCode).toBe(204);
    expect((await admin.delete(`/api/templates/${id}`)).statusCode).toBe(404);
  });
  it('hides user templates across households and rejects cross-household writes', async () => {
    const id = (await admin.post('/api/templates', body)).json<Json>().template.id;
    const { client } = await addOutsider(t.app, handle);
    expect(
      (await client.get('/api/templates')).json<Json>().templates.some((t: Json) => t.id === id),
    ).toBe(false);
    expect((await client.patch(`/api/templates/${id}`, body)).statusCode).toBe(404);
    expect((await client.delete(`/api/templates/${id}`)).statusCode).toBe(404);
  });
  it('rejects incomplete schedules, bad RRULEs, and missing custom times', async () => {
    for (const defaults of [
      { scheduleKind: 'fixed' },
      { scheduleKind: 'fixed', rrule: 'FREQ=NOPE' },
      { scheduleKind: 'after_completion' },
      { reminderSlot: 'custom_time' },
      { remindOffsetDays: 1 },
    ]) {
      expect((await admin.post('/api/templates', { ...body, defaults })).statusCode).toBe(400);
    }
  });
  it('round-trips working-day and bin reminder settings through create and patch', async () => {
    const res = await admin.post('/api/tasks', {
      title: 'Bins',
      scheduleKind: 'once',
      dueDate: '2026-03-07',
      workingDaysOnly: true,
      remindOffsetDays: -1,
    });
    expect(res.statusCode, res.body).toBe(201);
    const task = res.json<Json>().task;
    expect(task).toMatchObject({ workingDaysOnly: true, remindOffsetDays: -1 });
    const changed = await admin.patch(`/api/tasks/${task.id}`, {
      workingDaysOnly: false,
      remindOffsetDays: 0,
    });
    expect(changed.json<Json>().task).toMatchObject({
      workingDaysOnly: false,
      remindOffsetDays: 0,
    });
  });
  it('keeps shifted due-today dates when editing prep or working-day settings', async () => {
    const created = await admin.post('/api/tasks', {
      title: 'Sunday job',
      scheduleKind: 'fixed',
      rrule: 'FREQ=WEEKLY',
      dueDate: '2026-03-01',
      workingDaysOnly: true,
    });
    const id = created.json<Json>().task.id;
    t.clock.set('2026-03-02T09:00:00Z');
    expect((await admin.patch(`/api/tasks/${id}`, { leadTimeDays: 3 })).statusCode).toBe(200);
    const rows = () => handle.db.select().from(occurrence).where(eq(occurrence.taskId, id));
    expect((await rows()).filter((o) => o.dueDate === '2026-03-02')).toHaveLength(1);
    expect((await admin.patch(`/api/tasks/${id}`, { workingDaysOnly: false })).statusCode).toBe(
      200,
    );
    expect((await rows()).filter((o) => o.dueDate === '2026-03-01')).toHaveLength(1);
  });
});
