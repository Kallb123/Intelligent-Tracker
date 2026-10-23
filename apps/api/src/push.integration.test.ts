import { member, pushSubscription, type DbHandle } from '@tracker/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SUBSCRIPTIONS_PER_MEMBER } from './routes/push.js';
import {
  TestClient,
  addMember,
  createMigratedDatabase,
  createTestApp,
  setUpAdmin,
  type TestClock,
} from './test-util.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const KEY =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
const endpointOf = (n: number) => `https://push.example/send/${n}`;
const subscription = (n = 1, keys = { p256dh: `p256dh-${n}`, auth: `auth-${n}` }) => ({
  endpoint: endpointOf(n),
  keys,
});

describe.skipIf(!adminUrl)('web push subscriptions (integration)', () => {
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let handle: DbHandle;
  let app: FastifyInstance;
  let clock: TestClock;
  let admin: TestClient;

  beforeAll(async () => {
    database = await createMigratedDatabase(adminUrl as string);
    handle = database.handle;
  });
  afterAll(() => database?.close());

  beforeEach(async () => {
    await handle.sql`truncate household cascade`;
    ({ app, clock } = createTestApp(handle, { vapidPublicKey: KEY }));
    admin = await setUpAdmin(app);
  });

  const rows = () => handle.db.select().from(pushSubscription).orderBy(pushSubscription.endpoint);
  const memberId = async (username: string) =>
    (await handle.db.select().from(member).where(eq(member.username, username)))[0]?.id;

  /** A logged-in client of a fresh app (same database) whose deployment has no VAPID key. */
  async function withoutPush() {
    const { app: bare } = createTestApp(handle);
    const client = new TestClient(bare);
    await client.post(
      '/api/auth/login',
      { identifier: 'kallum', password: 'correct horse battery' },
      { csrf: false },
    );
    return client;
  }

  describe('access', () => {
    const routes = [
      ['GET', '/api/push/config'],
      ['POST', '/api/push/subscriptions'],
      ['DELETE', '/api/push/subscriptions'],
    ] as const;

    it.each(routes)('%s %s needs a session', async (method, url) => {
      const res = await new TestClient(app).request(method, url, {
        csrf: false,
        body: subscription(),
      });
      expect(res.statusCode).toBe(401);
    });

    it.each(routes.filter(([method]) => method !== 'GET'))(
      '%s %s needs the CSRF token',
      async (method, url) => {
        const res = await admin.request(method, url, { csrf: false, body: subscription() });
        expect(res.statusCode).toBe(403);
        expect(await rows()).toEqual([]);
      },
    );

    it('refuses a cross-origin request', async () => {
      const res = await admin.post('/api/push/subscriptions', subscription(), {
        headers: { origin: 'https://evil.example' },
      });
      expect(res.statusCode).toBe(403);
      expect(await rows()).toEqual([]);
    });
  });

  describe('config', () => {
    it('gives the VAPID public key to any member', async () => {
      const sam = await addMember(app, admin);
      expect((await admin.get('/api/push/config')).json()).toEqual({ publicKey: KEY });
      expect((await sam.client.get('/api/push/config')).json()).toEqual({ publicKey: KEY });
    });

    it('has a null key when push is not configured', async () => {
      const res = await (await withoutPush()).get('/api/push/config');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ publicKey: null });
    });
  });

  describe('subscribe', () => {
    it('stores the subscription for the caller with their user agent', async () => {
      const res = await admin.post('/api/push/subscriptions', subscription(1), {
        headers: { 'user-agent': 'Mozilla/5.0 (Test)' },
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');

      expect(await rows()).toEqual([
        expect.objectContaining({
          memberId: await memberId('kallum'),
          endpoint: endpointOf(1),
          p256dh: 'p256dh-1',
          auth: 'auth-1',
          userAgent: 'Mozilla/5.0 (Test)',
          lastSentAt: null,
        }),
      ]);
    });

    it('updates the keys when the same endpoint is saved again', async () => {
      await admin.post('/api/push/subscriptions', subscription(1));
      const [first] = await rows();
      clock.advance(60_000);

      const res = await admin.post(
        '/api/push/subscriptions',
        subscription(1, { p256dh: 'rotated', auth: 'rotated-auth' }),
      );
      expect(res.statusCode).toBe(204);

      const after = await rows();
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: first?.id, p256dh: 'rotated', auth: 'rotated-auth' });
      expect(after[0]?.updatedAt.getTime()).toBe(Date.parse('2026-03-01T12:01:00Z'));
    });

    it('moves an endpoint another member had saved (a shared device) to the caller', async () => {
      const sam = await addMember(app, admin);
      await sam.client.post('/api/push/subscriptions', subscription(1));
      await admin.post('/api/push/subscriptions', subscription(1, { p256dh: 'k', auth: 'a' }));

      expect(await rows()).toEqual([
        expect.objectContaining({ memberId: await memberId('kallum'), p256dh: 'k', auth: 'a' }),
      ]);
    });

    it('keeps several browsers per member', async () => {
      await admin.post('/api/push/subscriptions', subscription(1));
      await admin.post('/api/push/subscriptions', subscription(2));
      expect((await rows()).map((row) => row.endpoint)).toEqual([endpointOf(1), endpointOf(2)]);
    });

    it('keeps at most 20 per member, dropping the least recently saved', async () => {
      const sam = await addMember(app, admin);
      await sam.client.post('/api/push/subscriptions', subscription(100));
      for (let n = 1; n <= MAX_SUBSCRIPTIONS_PER_MEMBER; n++) {
        clock.advance(1000);
        await admin.post('/api/push/subscriptions', subscription(n));
      }
      expect(await rows()).toHaveLength(MAX_SUBSCRIPTIONS_PER_MEMBER + 1);

      // Saving the oldest again makes the next-oldest the one to go.
      clock.advance(1000);
      await admin.post('/api/push/subscriptions', subscription(1));
      clock.advance(1000);
      await admin.post('/api/push/subscriptions', subscription(21));

      const all = await rows();
      const endpoints = all.map((row) => row.endpoint);
      expect(all).toHaveLength(MAX_SUBSCRIPTIONS_PER_MEMBER + 1);
      expect(endpoints).toContain(endpointOf(1));
      expect(endpoints).toContain(endpointOf(21));
      expect(endpoints).not.toContain(endpointOf(2));
      // Another member's subscription is never pruned.
      expect(endpoints).toContain(endpointOf(100));
    });

    it('answers 409 push_not_configured without a VAPID key, and stores nothing', async () => {
      const res = await (await withoutPush()).post('/api/push/subscriptions', subscription());
      expect(res.statusCode).toBe(409);
      expect(res.json<Json>().error).toBe('push_not_configured');
      expect(await rows()).toEqual([]);
    });

    it.each([
      ['a non-https endpoint', { ...subscription(), endpoint: 'http://push.example/1' }],
      ['an endpoint that is not a URL', { ...subscription(), endpoint: 'nope' }],
      ['missing keys', { endpoint: endpointOf(1) }],
      ['an empty auth key', { endpoint: endpointOf(1), keys: { p256dh: 'x', auth: '' } }],
    ])('rejects %s', async (_name, body) => {
      const res = await admin.post('/api/push/subscriptions', body);
      expect(res.statusCode).toBe(400);
      expect(res.json<Json>().error).toBe('validation_error');
      expect(await rows()).toEqual([]);
    });
  });

  describe('unsubscribe', () => {
    it('removes the caller`s subscription with that endpoint only', async () => {
      await admin.post('/api/push/subscriptions', subscription(1));
      await admin.post('/api/push/subscriptions', subscription(2));

      const res = await admin.delete('/api/push/subscriptions', {
        body: { endpoint: endpointOf(1) },
      });
      expect(res.statusCode).toBe(204);
      expect((await rows()).map((row) => row.endpoint)).toEqual([endpointOf(2)]);
    });

    it('never removes another member`s subscription, but still answers 204', async () => {
      const sam = await addMember(app, admin);
      await sam.client.post('/api/push/subscriptions', subscription(1));

      const res = await admin.delete('/api/push/subscriptions', {
        body: { endpoint: endpointOf(1) },
      });
      expect(res.statusCode).toBe(204);
      expect(await rows()).toEqual([expect.objectContaining({ memberId: sam.id })]);
    });

    it('is idempotent', async () => {
      const first = await admin.delete('/api/push/subscriptions', {
        body: { endpoint: endpointOf(1) },
      });
      expect(first.statusCode).toBe(204);
    });

    it('still works when push is not configured, so people can always clean up', async () => {
      await admin.post('/api/push/subscriptions', subscription(1));
      const client = await withoutPush();
      const res = await client.delete('/api/push/subscriptions', {
        body: { endpoint: endpointOf(1) },
      });
      expect(res.statusCode).toBe(204);
      expect(await rows()).toEqual([]);
    });

    it('rejects a body without an endpoint', async () => {
      const res = await admin.delete('/api/push/subscriptions', { body: {} });
      expect(res.statusCode).toBe(400);
    });
  });

  it('removes a member`s subscriptions with the member', async () => {
    const sam = await addMember(app, admin);
    await sam.client.post('/api/push/subscriptions', subscription(1));
    await handle.db.delete(member).where(eq(member.id, sam.id));
    expect(await rows()).toEqual([]);
  });
});
