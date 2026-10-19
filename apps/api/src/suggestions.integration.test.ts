import { activity, occurrence, task, type DbHandle } from '@tracker/db';
import { seedSuggestionHistory } from '@tracker/db/test-db';
import type { SessionInfo, SuggestionDto, TaskDto } from '@tracker/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  addMember,
  addOutsider,
  createMigratedDatabase,
  createTestApp,
  setUpAdmin,
  TestClient,
  type TestApp,
} from './test-util.js';

const adminUrl = process.env['TEST_DATABASE_URL'];
describe.skipIf(!adminUrl)('history suggestions (integration)', () => {
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let handle: DbHandle;
  let t: TestApp;
  let admin: TestClient;
  let me: SessionInfo;
  beforeAll(async () => {
    database = await createMigratedDatabase(adminUrl!);
    handle = database.handle;
  });
  afterAll(async () => {
    await t?.app.close();
    await database?.close();
  });
  beforeEach(async () => {
    await t?.app.close();
    await handle.sql`truncate household cascade`;
    t = createTestApp(handle);
    admin = await setUpAdmin(t.app);
    me = (await admin.get('/api/auth/me')).json<SessionInfo>();
  });

  async function setup(
    extra: Record<string, unknown> = {},
    dates = ['2026-01-05', '2026-02-05', '2026-02-24'],
  ) {
    const res = await admin.post('/api/tasks', {
      title: 'Insurance',
      scheduleKind: 'fixed',
      rrule: 'FREQ=YEARLY',
      dueDate: '2026-04-14',
      reminderSlot: 'morning',
      leadTimeDays: 7,
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json<{ task: TaskDto }>().task;
    await seedSuggestionHistory(handle.db, {
      householdId: me.household.id,
      memberId: me.member.id,
      taskId: created.id,
      dates,
    });
    return created;
  }
  async function list(client = admin) {
    const res = await client.get('/api/suggestions');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ suggestions: SuggestionDto[] }>().suggestions;
  }
  async function stored(id: string) {
    return (await admin.get(`/api/tasks/${id}`)).json<{ task: TaskDto }>().task;
  }

  it('requires login and CSRF, validates actions, and reads without changing tasks or activity', async () => {
    const created = await setup();
    const before = await handle.db.select().from(activity);
    const cards = await list();
    expect(cards.map((s) => s.kind)).toEqual(['lateness', 'snoozes']);
    expect(await stored(created.id)).toEqual(created);
    expect(await handle.db.select().from(activity)).toEqual(before);
    const id = cards[0]!.id;
    const anon = new TestClient(t.app);
    expect((await anon.get('/api/suggestions')).statusCode).toBe(401);
    expect((await anon.post(`/api/suggestions/${id}`, { action: 'accept' })).statusCode).toBe(401);
    expect(
      (await admin.post(`/api/suggestions/${id}`, { action: 'accept' }, { csrf: false }))
        .statusCode,
    ).toBe(403);
    expect((await admin.post(`/api/suggestions/${id}`, { action: 'edit' })).statusCode).toBe(400);
  });

  it('accepts a lead, rematerialises future start dates, audits the actor, and rejects replay', async () => {
    const created = await setup();
    const [card] = await list();
    expect(
      (await admin.post(`/api/suggestions/${card!.id}`, { action: 'accept' })).statusCode,
    ).toBe(204);
    expect((await stored(created.id)).leadTimeDays).toBe(14);
    const open = await handle.db.select().from(occurrence).where(eq(occurrence.taskId, created.id));
    expect(open.find((o) => o.dueDate === '2026-04-14')?.startAt?.toISOString()).toBe(
      '2026-03-30T23:00:00.000Z',
    );
    expect(open.filter((o) => o.status === 'done')).toHaveLength(3);
    const logs = await handle.db
      .select()
      .from(activity)
      .where(eq(activity.kind, 'suggestion.accepted'));
    expect(logs).toMatchObject([
      {
        memberId: me.member.id,
        taskId: created.id,
        data: { kind: 'lateness', patch: { leadTimeDays: 14 } },
      },
    ]);
    expect(
      (await admin.post(`/api/suggestions/${card!.id}`, { action: 'accept' })).statusCode,
    ).toBe(409);
    expect((await list()).map((s) => s.kind)).toEqual(['snoozes']);
  });

  it('persists dismissal across settings changes until the history sample changes', async () => {
    const created = await setup();
    const card = (await list()).find((s) => s.kind === 'lateness')!;
    expect(
      (await admin.post(`/api/suggestions/${card.id}`, { action: 'dismiss' })).statusCode,
    ).toBe(204);
    expect((await stored(created.id)).leadTimeDays).toBe(7);
    await admin.patch(`/api/tasks/${created.id}`, { title: 'Renew insurance' });
    expect((await list()).map((s) => s.kind)).toEqual(['snoozes']);
    await seedSuggestionHistory(handle.db, {
      householdId: me.household.id,
      memberId: me.member.id,
      taskId: created.id,
      dates: ['2026-02-28'],
      snoozes: 0,
    });
    expect((await list()).map((s) => s.kind)).toEqual(['lateness']);
  });

  it('accepts a snooze suggestion once under concurrent presses', async () => {
    const created = await setup();
    const card = (await list()).find((s) => s.kind === 'snoozes')!;
    const responses = await Promise.all(
      [1, 2, 3].map(() => admin.post(`/api/suggestions/${card.id}`, { action: 'accept' })),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([204, 409, 409]);
    expect((await stored(created.id)).reminderSlot).toBe('evening');
    expect(
      await handle.db.select().from(activity).where(eq(activity.kind, 'suggestion.accepted')),
    ).toHaveLength(1);
  });

  it('isolates households and refuses changed, archived or deleted cards', async () => {
    const created = await setup();
    const [card] = await list();
    const outsider = await addOutsider(t.app, handle);
    expect(await list(outsider.client)).toEqual([]);
    expect(
      (await outsider.client.post(`/api/suggestions/${card!.id}`, { action: 'accept' })).statusCode,
    ).toBe(409);
    await admin.patch(`/api/tasks/${created.id}`, { leadTimeDays: 30 });
    expect(
      (await admin.post(`/api/suggestions/${card!.id}`, { action: 'accept' })).statusCode,
    ).toBe(409);
    expect((await stored(created.id)).leadTimeDays).toBe(30);
    const [fresh] = await list();
    await admin.patch(`/api/tasks/${created.id}`, { archived: true });
    expect(await list()).toEqual([]);
    expect(
      (await admin.post(`/api/suggestions/${fresh!.id}`, { action: 'dismiss' })).statusCode,
    ).toBe(409);
    await admin.delete(`/api/tasks/${created.id}`);
    expect(
      (await admin.post(`/api/suggestions/${fresh!.id}`, { action: 'accept' })).statusCode,
    ).toBe(409);
  });

  it('accepts fairness by changing the next rotation turn and preserves started jobs', async () => {
    t.clock.set('2026-03-30T12:00:00Z');
    expect(
      (
        await admin.post('/api/auth/login', {
          identifier: ADMIN.username,
          password: ADMIN.password,
        })
      ).statusCode,
    ).toBe(200);
    const sam = await addMember(t.app, admin);
    const created = await setup(
      { assignmentMode: 'rotation', assigneeIds: [me.member.id, sam.id] },
      ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'],
    );
    const [started] = await handle.db
      .insert(occurrence)
      .values({
        taskId: created.id,
        dueDate: '2026-03-31',
        status: 'started',
        assigneeId: me.member.id,
      })
      .returning();
    const card = (await list()).find((s) => s.kind === 'fairness')!;
    expect(card.message).toContain('100%');
    expect(
      (await sam.client.post(`/api/suggestions/${card.id}`, { action: 'accept' })).statusCode,
    ).toBe(204);
    const [row] = await handle.db.select().from(task).where(eq(task.id, created.id));
    expect(row?.rotationCursor).toBe(1);
    const rows = await handle.db.select().from(occurrence).where(eq(occurrence.taskId, created.id));
    expect(rows.find((o) => o.id === started!.id)?.assigneeId).toBe(me.member.id);
    expect(rows.find((o) => o.dueDate === '2026-04-14')?.assigneeId).toBe(sam.id);
    expect((await list()).map((s) => s.kind)).not.toContain('fairness');
  });

  it('does not use skipped or unlogged completions as evidence', async () => {
    const created = await setup();
    await handle.db
      .update(occurrence)
      .set({ status: 'skipped' })
      .where(eq(occurrence.taskId, created.id));
    expect(await list()).toEqual([]);
    await handle.db
      .update(occurrence)
      .set({ status: 'done' })
      .where(eq(occurrence.taskId, created.id));
    await handle.db.delete(activity).where(eq(activity.kind, 'occurrence.completed'));
    expect(await list()).toEqual([]);
  });
});
