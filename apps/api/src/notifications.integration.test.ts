import { member, notification, serviceHeartbeat, type DbHandle } from '@tracker/db';
import type { ReminderPayload } from '@tracker/shared';
import { eq } from 'drizzle-orm';
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

const MINUTE = 60 * 1000;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// The test clock starts at 2026-03-01T12:00:00Z.
describe.skipIf(!adminUrl)('notifications (integration)', () => {
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let handle: DbHandle;
  let t: TestApp;
  let app: FastifyInstance;
  let admin: TestClient;
  let adminId: string;
  let householdId: string;

  beforeAll(async () => {
    database = await createMigratedDatabase(adminUrl as string);
    handle = database.handle;
  });
  afterAll(() => database?.close());

  beforeEach(async () => {
    await handle.sql`truncate household cascade`;
    t = createTestApp(handle);
    app = t.app;
    admin = await setUpAdmin(app);
    const [me] = await handle.db.select().from(member);
    adminId = me?.id as string;
    householdId = me?.householdId as string;
  });

  const payload = (title: string, overrides: Partial<ReminderPayload> = {}): ReminderPayload => ({
    type: 'reminder',
    kind: 'due',
    taskId: crypto.randomUUID(),
    occurrenceId: crypto.randomUUID(),
    taskTitle: title,
    dueDate: '2026-03-02',
    dueAt: null,
    fireAt: '2026-03-01T08:00:00.000Z',
    assigneeId: null,
    ...overrides,
  });

  let seq = 0;
  /** Inserts a notification straight into the outbox; delivered (`sent_at` set) unless told otherwise. */
  async function notify(
    memberId: string | null,
    title: string,
    options: {
      createdAt?: string;
      sent?: boolean;
      readAt?: string | null;
      channel?: 'in_app' | 'telegram_group';
      householdId?: string;
    } = {},
  ): Promise<string> {
    const createdAt = new Date(options.createdAt ?? '2026-03-01T09:00:00Z');
    const [row] = await handle.db
      .insert(notification)
      .values({
        householdId: options.householdId ?? householdId,
        memberId,
        channel: options.channel ?? 'in_app',
        payload: payload(title),
        dedupeKey: `test:${seq++}`,
        createdAt,
        sentAt: options.sent === false ? null : createdAt,
        readAt: options.readAt ? new Date(options.readAt) : null,
      })
      .returning({ id: notification.id });
    return row?.id as string;
  }

  const titles = (res: { json: <T>() => T }) =>
    res.json<Json>().items.map((i: Json) => i['payload'].taskTitle);

  describe('access', () => {
    it('needs a session on every route', async () => {
      const anon = new TestClient(app);
      const id = '00000000-0000-4000-8000-000000000000';
      for (const [method, url] of [
        ['GET', '/api/notifications'],
        ['POST', `/api/notifications/${id}/read`],
        ['POST', '/api/notifications/read-all'],
      ] as const) {
        const res = await anon.request(method, url, { csrf: false });
        expect([method, url, res.statusCode]).toEqual([method, url, 401]);
      }
    });

    it('needs the CSRF token to mark read', async () => {
      const id = await notify(adminId, 'Bins');
      for (const url of [`/api/notifications/${id}/read`, '/api/notifications/read-all']) {
        const res = await admin.post(url, undefined, { csrf: false });
        expect([url, res.statusCode]).toEqual([url, 403]);
      }
      expect((await admin.get('/api/notifications')).json<Json>().unreadCount).toBe(1);
    });
  });

  describe('GET /api/notifications', () => {
    it('is empty without notifications', async () => {
      const res = await admin.get('/api/notifications');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [], unreadCount: 0 });
    });

    it('lists the newest first, with the payload, and counts the unread', async () => {
      await notify(adminId, 'Oldest', { createdAt: '2026-03-01T08:00:00Z' });
      await notify(adminId, 'Newest', { createdAt: '2026-03-01T11:00:00Z' });
      await notify(adminId, 'Middle', {
        createdAt: '2026-03-01T10:00:00Z',
        readAt: '2026-03-01T10:30:00Z',
      });

      const res = await admin.get('/api/notifications');

      expect(res.statusCode).toBe(200);
      expect(titles(res)).toEqual(['Newest', 'Middle', 'Oldest']);
      expect(res.json<Json>().unreadCount).toBe(2);
      const [first, second] = res.json<Json>().items;
      expect(first).toEqual({
        id: expect.any(String),
        createdAt: '2026-03-01T11:00:00.000Z',
        readAt: null,
        payload: expect.objectContaining({ type: 'reminder', kind: 'due', taskTitle: 'Newest' }),
      });
      expect(second['readAt']).toBe('2026-03-01T10:30:00.000Z');
    });

    it('limits the items but counts every unread one', async () => {
      for (let i = 0; i < 5; i++) {
        await notify(adminId, `N${i}`, { createdAt: `2026-03-01T0${i}:00:00Z` });
      }

      const res = await admin.get('/api/notifications?limit=2');

      expect(titles(res)).toEqual(['N4', 'N3']);
      expect(res.json<Json>().unreadCount).toBe(5);
      expect((await admin.get('/api/notifications?limit=0')).statusCode).toBe(400);
      expect((await admin.get('/api/notifications?limit=101')).statusCode).toBe(400);
    });

    it('only shows my own delivered in-app notifications', async () => {
      const sam = await addMember(app, admin);
      const outsider = await addOutsider(app, handle);
      await notify(adminId, 'Mine');
      await notify(adminId, 'Not delivered yet', { sent: false });
      await notify(adminId, 'Telegram', { channel: 'telegram_group' });
      await notify(sam.id, 'Sams');
      await notify(outsider.memberId, 'Strangers', { householdId: outsider.householdId });

      const mine = await admin.get('/api/notifications');
      expect(titles(mine)).toEqual(['Mine']);
      expect(mine.json<Json>().unreadCount).toBe(1);
      expect(titles(await sam.client.get('/api/notifications'))).toEqual(['Sams']);
      expect(titles(await outsider.client.get('/api/notifications'))).toEqual(['Strangers']);
    });
  });

  describe('marking read', () => {
    it('marks one notification read', async () => {
      const first = await notify(adminId, 'First', { createdAt: '2026-03-01T08:00:00Z' });
      await notify(adminId, 'Second', { createdAt: '2026-03-01T09:00:00Z' });

      const res = await admin.post(`/api/notifications/${first}/read`);

      expect(res.statusCode).toBe(204);
      const list = (await admin.get('/api/notifications')).json<Json>();
      expect(list.unreadCount).toBe(1);
      expect(list.items.map((i: Json) => [i['payload'].taskTitle, i['readAt']])).toEqual([
        ['Second', null],
        ['First', t.clock.now().toISOString()],
      ]);
    });

    it('keeps the first read time when read again', async () => {
      const id = await notify(adminId, 'Bins');
      await admin.post(`/api/notifications/${id}/read`);
      t.clock.advance(10 * MINUTE);

      expect((await admin.post(`/api/notifications/${id}/read`)).statusCode).toBe(204);

      const [row] = await handle.db.select().from(notification).where(eq(notification.id, id));
      expect(row?.readAt?.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    });

    it('answers 404 for someone else’s, another household’s, undelivered and unknown ones', async () => {
      const sam = await addMember(app, admin);
      const outsider = await addOutsider(app, handle);
      const others = [
        await notify(sam.id, 'Sams'),
        await notify(outsider.memberId, 'Strangers', { householdId: outsider.householdId }),
        await notify(adminId, 'Not delivered yet', { sent: false }),
        await notify(adminId, 'Telegram', { channel: 'telegram_group' }),
        '00000000-0000-4000-8000-000000000000',
      ];

      for (const id of others) {
        const res = await admin.post(`/api/notifications/${id}/read`);
        expect([id, res.statusCode]).toEqual([id, 404]);
      }
      expect((await admin.post('/api/notifications/not-a-uuid/read')).statusCode).toBe(400);
      const rows = await handle.db.select({ readAt: notification.readAt }).from(notification);
      expect(rows.every((r) => r.readAt === null)).toBe(true);
    });

    it('marks all of mine read and leaves everyone else’s alone', async () => {
      const sam = await addMember(app, admin);
      await notify(adminId, 'A');
      await notify(adminId, 'B', { readAt: '2026-03-01T10:00:00Z' });
      await notify(adminId, 'Not delivered yet', { sent: false });
      await notify(sam.id, 'Sams');

      const res = await admin.post('/api/notifications/read-all');

      expect(res.statusCode).toBe(204);
      expect((await admin.get('/api/notifications')).json<Json>().unreadCount).toBe(0);
      expect((await sam.client.get('/api/notifications')).json<Json>().unreadCount).toBe(1);
      const rows = await handle.db.select().from(notification);
      expect(
        rows.map((r) => [r.payload.taskTitle, r.readAt?.toISOString() ?? null]).sort(),
      ).toEqual([
        ['A', '2026-03-01T12:00:00.000Z'],
        ['B', '2026-03-01T10:00:00.000Z'],
        ['Not delivered yet', null],
        ['Sams', null],
      ]);
    });
  });

  describe('GET /api/health worker heartbeat', () => {
    const health = async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      return res.json<Json>();
    };
    const beat = (ago: number) =>
      handle.db
        .insert(serviceHeartbeat)
        .values({ service: 'worker', beatAt: new Date(t.clock.now().getTime() - ago) })
        .onConflictDoUpdate({
          target: serviceHeartbeat.service,
          set: { beatAt: new Date(t.clock.now().getTime() - ago) },
        });

    it('reports a missing heartbeat as stale, but still ok', async () => {
      const body = await health();
      expect(body).toMatchObject({ status: 'ok', service: 'api' });
      expect(body['worker']).toEqual({ lastBeatAt: null, stale: true });
    });

    it('reports a fresh heartbeat', async () => {
      await beat(30_000);
      expect((await health())['worker']).toEqual({
        lastBeatAt: '2026-03-01T11:59:30.000Z',
        stale: false,
      });
    });

    it('goes stale after five minutes', async () => {
      await beat(5 * MINUTE);
      expect((await health())['worker'].stale).toBe(false);
      await beat(5 * MINUTE + 1000);
      expect(await health()).toMatchObject({
        status: 'ok',
        worker: { lastBeatAt: '2026-03-01T11:54:59.000Z', stale: true },
      });
    });
  });
});
