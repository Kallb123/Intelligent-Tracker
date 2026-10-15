import { hashToken, household, member, type DbHandle } from '@tracker/db';
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
} from './test-util.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

const HOUR = 60 * 60 * 1000;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// The test clock starts at 2026-03-01T12:00:00Z.
describe.skipIf(!adminUrl)('telegram linking (integration)', () => {
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let handle: DbHandle;
  let app: FastifyInstance;
  let admin: TestClient;

  beforeAll(async () => {
    database = await createMigratedDatabase(adminUrl as string);
    handle = database.handle;
  });
  afterAll(() => database?.close());

  beforeEach(async () => {
    await handle.sql`truncate household cascade`;
    ({ app } = createTestApp(handle, { telegramBotUsername: 'tracker_bot' }));
    admin = await setUpAdmin(app);
  });

  const householdRow = async () => (await handle.db.select().from(household))[0];
  const memberRow = async (username: string) =>
    (await handle.db.select().from(member).where(eq(member.username, username)))[0];

  describe('access', () => {
    const routes = [
      ['GET', '/api/telegram'],
      ['POST', '/api/telegram/link'],
      ['DELETE', '/api/telegram/link'],
      ['POST', '/api/telegram/group-link'],
      ['DELETE', '/api/telegram/group-link'],
    ] as const;

    it.each(routes)('%s %s needs a session', async (method, url) => {
      const res = await new TestClient(app).request(method, url, { csrf: false });
      expect(res.statusCode).toBe(401);
    });

    it.each(routes.filter(([method]) => method !== 'GET'))(
      '%s %s needs the CSRF token',
      async (method, url) => {
        expect((await admin.request(method, url, { csrf: false })).statusCode).toBe(403);
      },
    );

    it('refuses a cross-origin request', async () => {
      const res = await admin.post('/api/telegram/link', undefined, {
        headers: { origin: 'https://evil.example' },
      });
      expect(res.statusCode).toBe(403);
      expect((await memberRow('kallum'))?.telegramLinkCode).toBeNull();
    });
  });

  describe('status', () => {
    it('reports the bot, and that nothing is linked yet', async () => {
      const res = await admin.get('/api/telegram');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        botUsername: 'tracker_bot',
        groupLinked: false,
        memberLinked: false,
      });
    });

    it('has a null botUsername when none is configured', async () => {
      ({ app } = createTestApp(handle));
      const login = new TestClient(app);
      await login.post(
        '/api/auth/login',
        { identifier: 'kallum', password: 'correct horse battery' },
        { csrf: false },
      );
      expect((await login.get('/api/telegram')).json<Json>().botUsername).toBeNull();
    });

    it('reflects the caller`s own link and the household`s group link', async () => {
      const sam = await addMember(app, admin);
      await handle.db.update(member).set({ telegramUserId: 42 }).where(eq(member.id, sam.id));
      await handle.db.update(household).set({ telegramGroupChatId: -1001 });

      expect((await sam.client.get('/api/telegram')).json()).toMatchObject({
        groupLinked: true,
        memberLinked: true,
      });
      expect((await admin.get('/api/telegram')).json()).toMatchObject({
        groupLinked: true,
        memberLinked: false,
      });
    });

    it('does not see another household`s group', async () => {
      const outsider = await addOutsider(app, handle);
      await handle.db
        .update(household)
        .set({ telegramGroupChatId: -1001 })
        .where(eq(household.id, outsider.householdId));

      expect((await admin.get('/api/telegram')).json<Json>().groupLinked).toBe(false);
      expect((await outsider.client.get('/api/telegram')).json<Json>().groupLinked).toBe(true);
    });

    it('shows on the members list as telegramLinked, without the Telegram id', async () => {
      const sam = await addMember(app, admin);
      await handle.db.update(member).set({ telegramUserId: 424242 }).where(eq(member.id, sam.id));

      const res = await admin.get('/api/members');
      const members = res.json<Json>().members as Json[];
      expect(members.map((m) => [m.username, m.telegramLinked])).toEqual([
        ['kallum', false],
        ['sam', true],
      ]);
      expect(res.body).not.toContain('424242');
      expect(res.body).not.toContain('telegramUserId');
    });
  });

  describe('member link', () => {
    it('issues a one-hour code and a deep link, and stores only its hash', async () => {
      const res = await admin.post('/api/telegram/link');
      expect(res.statusCode).toBe(200);
      const body = res.json<Json>();

      expect(body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.url).toBe(`https://t.me/tracker_bot?start=${body.code}`);
      expect(body.expiresAt).toBe('2026-03-01T13:00:00.000Z');

      const row = await memberRow('kallum');
      expect(row?.telegramLinkCode).toBe(hashToken(body.code));
      expect(row?.telegramLinkCode).not.toBe(body.code);
      expect(row?.telegramLinkExpiresAt?.getTime()).toBe(Date.parse('2026-03-01T12:00:00Z') + HOUR);
    });

    it('replaces the earlier code', async () => {
      const first = (await admin.post('/api/telegram/link')).json<Json>();
      const second = (await admin.post('/api/telegram/link')).json<Json>();
      expect(second.code).not.toBe(first.code);
      expect((await memberRow('kallum'))?.telegramLinkCode).toBe(hashToken(second.code));
    });

    it('has no deep link without a configured bot username', async () => {
      ({ app } = createTestApp(handle));
      const client = new TestClient(app);
      await client.post(
        '/api/auth/login',
        { identifier: 'kallum', password: 'correct horse battery' },
        { csrf: false },
      );

      const res = await client.post('/api/telegram/link');
      expect(res.statusCode).toBe(200);
      expect(res.json<Json>()).toMatchObject({ code: expect.any(String), url: null });
    });

    it('is open to plain members, who only ever link themselves', async () => {
      const sam = await addMember(app, admin);
      const res = await sam.client.post('/api/telegram/link');
      expect(res.statusCode).toBe(200);
      expect((await memberRow('sam'))?.telegramLinkCode).toBe(hashToken(res.json<Json>().code));
      expect((await memberRow('kallum'))?.telegramLinkCode).toBeNull();
    });

    it('unlinks the caller`s account and cancels a pending code', async () => {
      const sam = await addMember(app, admin);
      await handle.db.update(member).set({ telegramUserId: 42 }).where(eq(member.id, sam.id));
      await handle.db
        .update(member)
        .set({ telegramUserId: 43 })
        .where(eq(member.username, 'kallum'));
      await sam.client.post('/api/telegram/link');

      const res = await sam.client.delete('/api/telegram/link');
      expect(res.statusCode).toBe(204);

      const row = await memberRow('sam');
      expect(row).toMatchObject({
        telegramUserId: null,
        telegramLinkCode: null,
        telegramLinkExpiresAt: null,
      });
      expect((await memberRow('kallum'))?.telegramUserId).toBe(43);
      expect((await sam.client.get('/api/telegram')).json<Json>().memberLinked).toBe(false);
      // Unlinking when nothing is linked is fine too.
      expect((await sam.client.delete('/api/telegram/link')).statusCode).toBe(204);
    });
  });

  describe('group link', () => {
    it('issues a one-hour code and the command, and stores only its hash', async () => {
      const res = await admin.post('/api/telegram/group-link');
      expect(res.statusCode).toBe(200);
      const body = res.json<Json>();

      expect(body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.command).toBe(`/linkgroup ${body.code}`);
      expect(body.expiresAt).toBe('2026-03-01T13:00:00.000Z');

      const row = await householdRow();
      expect(row?.telegramGroupLinkCode).toBe(hashToken(body.code));
      expect(row?.telegramGroupLinkCode).not.toBe(body.code);
      expect(row?.telegramGroupLinkExpiresAt?.getTime()).toBe(
        Date.parse('2026-03-01T12:00:00Z') + HOUR,
      );
    });

    it('is admin only', async () => {
      const sam = await addMember(app, admin);

      const issued = await sam.client.post('/api/telegram/group-link');
      expect(issued.statusCode).toBe(403);
      expect(issued.json()).toMatchObject({ error: 'forbidden' });
      expect((await householdRow())?.telegramGroupLinkCode).toBeNull();

      await handle.db.update(household).set({ telegramGroupChatId: -1001 });
      expect((await sam.client.delete('/api/telegram/group-link')).statusCode).toBe(403);
      expect((await householdRow())?.telegramGroupChatId).toBe(-1001);
    });

    it('unlinks the group and cancels a pending code', async () => {
      await admin.post('/api/telegram/group-link');
      await handle.db.update(household).set({ telegramGroupChatId: -1001 });

      const res = await admin.delete('/api/telegram/group-link');
      expect(res.statusCode).toBe(204);

      expect(await householdRow()).toMatchObject({
        telegramGroupChatId: null,
        telegramGroupLinkCode: null,
        telegramGroupLinkExpiresAt: null,
      });
      expect((await admin.get('/api/telegram')).json<Json>().groupLinked).toBe(false);
    });

    it('only touches the admin`s own household', async () => {
      const outsider = await addOutsider(app, handle);
      await handle.db
        .update(household)
        .set({ telegramGroupChatId: -1002 })
        .where(eq(household.id, outsider.householdId));

      await admin.post('/api/telegram/group-link');
      await admin.delete('/api/telegram/group-link');

      const [other] = await handle.db
        .select()
        .from(household)
        .where(eq(household.id, outsider.householdId));
      expect(other?.telegramGroupChatId).toBe(-1002);
    });
  });
});
