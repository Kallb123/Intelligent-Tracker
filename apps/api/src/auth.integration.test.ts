import { createHash } from 'node:crypto';
import { household, member, passwordToken, session, type DbHandle } from '@tracker/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  TestClient,
  createMigratedDatabase,
  createTestApp,
  type TestApp,
} from './test-util.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!adminUrl)('auth (integration)', () => {
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let handle: DbHandle;
  let t: TestApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    database = await createMigratedDatabase(adminUrl as string);
    handle = database.handle;
  });
  afterAll(() => database?.close());

  beforeEach(async () => {
    await handle.sql`truncate household cascade`;
    t = createTestApp(handle);
    app = t.app;
  });

  /** Runs first-run setup and returns the logged-in admin. */
  async function setUpAdmin(overrides: Json = {}): Promise<TestClient> {
    const admin = new TestClient(app);
    const res = await admin.post('/api/setup', { ...ADMIN, ...overrides }, { csrf: false });
    expect(res.statusCode).toBe(201);
    return admin;
  }

  /** Invites a member and returns the invite token. */
  async function invite(admin: TestClient, body: Json = {}): Promise<string> {
    const res = await admin.post('/api/invites', {
      name: 'Sam',
      username: 'sam',
      email: 'sam@example.com',
      ...body,
    });
    expect(res.statusCode).toBe(201);
    return res.json<Json>().invite.token;
  }

  /** Invites a member, has them accept with `password` and returns their logged-in client. */
  async function addMember(admin: TestClient, body: Json = {}, password = 'sams long password') {
    const token = await invite(admin, body);
    const client = new TestClient(app);
    const res = await client.post(`/api/invites/${token}/accept`, { password }, { csrf: false });
    expect(res.statusCode).toBe(200);
    return client;
  }

  const login = (client: TestClient, identifier: string, password: string, extra: Json = {}) =>
    client.post('/api/auth/login', { identifier, password, ...extra }, { csrf: false });

  describe('first-run setup', () => {
    it('reports that setup is needed, then done', async () => {
      const client = new TestClient(app);
      expect((await client.get('/api/setup')).json()).toEqual({ needsSetup: true });

      await setUpAdmin();
      expect((await client.get('/api/setup')).json()).toEqual({ needsSetup: false });
    });

    it('creates the household with UK defaults and an admin, and logs them in', async () => {
      const admin = new TestClient(app);
      const res = await admin.post('/api/setup', ADMIN, { csrf: false });

      expect(res.statusCode).toBe(201);
      const body = res.json<Json>();
      expect(body.member).toMatchObject({
        name: 'Kallum',
        username: 'kallum',
        email: 'kallum@example.com',
        role: 'admin',
        pending: false,
      });
      expect(body.household).toMatchObject({
        name: 'The Burgins',
        timezone: 'Europe/London',
        locale: 'en-GB',
      });
      expect(body.csrfToken).toEqual(expect.any(String));

      const me = await admin.get('/api/auth/me');
      expect(me.statusCode).toBe(200);
      expect(me.json<Json>().member.username).toBe('kallum');
    });

    it('stores an argon2id hash, never the password', async () => {
      await setUpAdmin();
      const [row] = await handle.db.select().from(member);
      expect(row?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/);
      expect(row?.passwordHash).not.toContain(ADMIN.password);
    });

    it('answers 409 once the household exists', async () => {
      await setUpAdmin();
      const res = await new TestClient(app).post(
        '/api/setup',
        { ...ADMIN, username: 'other' },
        { csrf: false },
      );
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'already_set_up' });
      expect(await handle.db.select().from(household)).toHaveLength(1);
    });

    it('lets exactly one of several simultaneous setups win', async () => {
      const results = await Promise.all(
        [1, 2, 3, 4].map((n) =>
          new TestClient(app).post(
            '/api/setup',
            { ...ADMIN, username: `admin${n}`, email: `a${n}@example.com` },
            { csrf: false },
          ),
        ),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409]);
      expect(await handle.db.select().from(household)).toHaveLength(1);
      expect(await handle.db.select().from(member)).toHaveLength(1);
    });

    it('validates the request', async () => {
      const post = (body: Json) => new TestClient(app).post('/api/setup', body, { csrf: false });
      for (const bad of [
        { ...ADMIN, password: 'short' },
        { ...ADMIN, username: 'has@sign' },
        { ...ADMIN, email: 'not-an-email' },
        { ...ADMIN, householdName: '' },
      ]) {
        const res = await post(bad);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'validation_error' });
      }
      expect((await new TestClient(app).get('/api/setup')).json()).toEqual({ needsSetup: true });
    });
  });

  describe('login and sessions', () => {
    it('logs in by username or email, ignoring case', async () => {
      await setUpAdmin();
      for (const identifier of ['kallum', 'KALLUM', 'Kallum@Example.com']) {
        const client = new TestClient(app);
        const res = await login(client, identifier, ADMIN.password);
        expect(res.statusCode).toBe(200);
        expect(res.json<Json>().member.username).toBe('kallum');
      }
    });

    it('rejects a wrong password and an unknown user with the same generic error', async () => {
      await setUpAdmin();
      const wrongPassword = await login(new TestClient(app), 'kallum', 'not the password');
      const unknownUser = await login(new TestClient(app), 'nobody', 'not the password');

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownUser.statusCode).toBe(401);
      expect(unknownUser.json()).toEqual(wrongPassword.json());
      expect(wrongPassword.headers['set-cookie']).toBeUndefined();
    });

    it('does not let an invited member log in before they accept', async () => {
      const admin = await setUpAdmin();
      await invite(admin);
      const res = await login(new TestClient(app), 'sam', 'anything at all');
      expect(res.statusCode).toBe(401);
    });

    it('sets an HTTP-only, SameSite=Lax cookie that ends with the browser session', async () => {
      await setUpAdmin();
      const client = new TestClient(app);
      await login(client, 'kallum', ADMIN.password);

      expect(client.lastCookie).toMatchObject({
        name: 'session',
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
      });
      expect(client.lastCookie?.maxAge).toBeUndefined();
      expect(client.lastCookie?.expires).toBeUndefined();
      expect(client.lastCookie?.secure).toBeFalsy();
    });

    it('uses a Secure __Host- cookie when configured', async () => {
      t = createTestApp(handle, { cookieSecure: true });
      app = t.app;
      const client = await setUpAdmin();

      expect(client.lastCookie).toMatchObject({
        name: '__Host-session',
        secure: true,
        httpOnly: true,
        path: '/',
      });
      expect((await client.get('/api/auth/me')).statusCode).toBe(200);
    });

    it('stores only a hash of the cookie token as the session id', async () => {
      const client = await setUpAdmin();
      const token = client.cookie?.split('=')[1] ?? '';
      const [row] = await handle.db.select().from(session);

      expect(row?.id).toBe(createHash('sha256').update(token).digest('hex'));
      expect(row?.id).not.toBe(token);
    });

    it('lasts a day by default and 30 days with remember me', async () => {
      await setUpAdmin();
      const now = t.clock.now().getTime();

      const plain = new TestClient(app);
      await login(plain, 'kallum', ADMIN.password);
      const remembered = new TestClient(app);
      await login(remembered, 'kallum', ADMIN.password, { remember: true });

      const rows = await handle.db.select().from(session);
      const expiries = rows.map((r) => r.expiresAt.getTime() - now).sort((a, b) => a - b);
      // The first row is the setup session (also a plain one).
      expect(expiries).toEqual([DAY, DAY, 30 * DAY]);
      expect(remembered.lastCookie?.maxAge).toBe(30 * 24 * 60 * 60);
      expect(plain.lastCookie?.maxAge).toBeUndefined();
    });

    it('rejects an expired session and removes it', async () => {
      const client = await setUpAdmin();
      expect((await client.get('/api/auth/me')).statusCode).toBe(200);

      t.clock.advance(DAY + MINUTE);
      const res = await client.get('/api/auth/me');

      expect(res.statusCode).toBe(401);
      expect(await handle.db.select().from(session)).toHaveLength(0);
      // ...and the dead cookie is cleared.
      expect(res.headers['set-cookie']).toMatch(/session=;/);
    });

    it('keeps a remembered session alive past a day', async () => {
      await setUpAdmin();
      const client = new TestClient(app);
      await login(client, 'kallum', ADMIN.password, { remember: true });

      t.clock.advance(29 * DAY);
      expect((await client.get('/api/auth/me')).statusCode).toBe(200);
      t.clock.advance(2 * DAY);
      expect((await client.get('/api/auth/me')).statusCode).toBe(401);
    });

    it('logs out by deleting the server-side session', async () => {
      const client = await setUpAdmin();
      const stolenCookie = client.cookie;

      const res = await client.post('/api/auth/logout');
      expect(res.statusCode).toBe(200);
      expect(await handle.db.select().from(session)).toHaveLength(0);

      // Even a copy of the old cookie no longer works.
      const replay = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: stolenCookie as string },
      });
      expect(replay.statusCode).toBe(401);
    });

    it('rejects garbage and missing cookies', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: 'session=not-a-real-token' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('CSRF', () => {
    it('refuses a mutating request without the token, with a wrong one, and allows the right one', async () => {
      const admin = await setUpAdmin();
      const body = { name: 'Sam', username: 'sam' };

      const missing = await admin.post('/api/invites', body, { csrf: false });
      expect(missing.statusCode).toBe(403);
      expect(missing.json()).toMatchObject({ error: 'forbidden' });

      const wrong = await admin.post('/api/invites', body, { csrf: 'x'.repeat(43) });
      expect(wrong.statusCode).toBe(403);

      const ok = await admin.post('/api/invites', body);
      expect(ok.statusCode).toBe(201);
    });

    it("rejects another session's token", async () => {
      const admin = await setUpAdmin();
      const other = new TestClient(app);
      await login(other, 'kallum', ADMIN.password);

      const res = await admin.post('/api/auth/logout', undefined, { csrf: other.csrfToken ?? '' });
      expect(res.statusCode).toBe(403);
    });

    it('does not require the token for reads', async () => {
      const admin = await setUpAdmin();
      expect((await admin.get('/api/members', { csrf: false })).statusCode).toBe(200);
    });

    it('checks authentication before CSRF, so anonymous callers get 401', async () => {
      const res = await new TestClient(app).post('/api/invites', {}, { csrf: false });
      expect(res.statusCode).toBe(401);
    });

    it('refuses cross-origin requests, including the public ones', async () => {
      const evil = { origin: 'https://evil.example', host: 'tracker.home' };
      const setup = await new TestClient(app).post('/api/setup', ADMIN, {
        csrf: false,
        headers: evil,
      });
      expect(setup.statusCode).toBe(403);
      expect((await new TestClient(app).get('/api/setup')).json()).toEqual({ needsSetup: true });

      await setUpAdmin();
      const loginRes = await login(new TestClient(app), 'kallum', ADMIN.password);
      expect(loginRes.statusCode).toBe(200);
      const crossSite = await new TestClient(app).post(
        '/api/auth/login',
        { identifier: 'kallum', password: ADMIN.password },
        { csrf: false, headers: evil },
      );
      expect(crossSite.statusCode).toBe(403);
      const nullOrigin = await new TestClient(app).post(
        '/api/auth/login',
        { identifier: 'kallum', password: ADMIN.password },
        { csrf: false, headers: { origin: 'null' } },
      );
      expect(nullOrigin.statusCode).toBe(403);
    });

    it('allows same-origin requests', async () => {
      const sameOrigin = { origin: 'https://tracker.home', host: 'tracker.home' };
      const res = await new TestClient(app).post('/api/setup', ADMIN, {
        csrf: false,
        headers: sameOrigin,
      });
      expect(res.statusCode).toBe(201);
    });

    it('allows the configured public origin', async () => {
      t = createTestApp(handle, { publicBaseUrl: 'https://tracker.example' });
      app = t.app;
      const res = await new TestClient(app).post('/api/setup', ADMIN, {
        csrf: false,
        headers: { origin: 'https://tracker.example', host: 'api:3000' },
      });
      expect(res.statusCode).toBe(201);
    });

    it('only accepts JSON bodies, so cross-site forms cannot post', async () => {
      for (const [type, payload] of [
        ['text/plain', JSON.stringify({ identifier: 'kallum', password: 'x' })],
        ['application/x-www-form-urlencoded', 'identifier=kallum&password=x'],
      ] as const) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'content-type': type },
          payload,
        });
        expect(res.statusCode).toBe(415);
      }
    });

    it('answers 400 for malformed JSON', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: '{nope',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('login rate limiting', () => {
    it('blocks a username after 5 failures, even for the right password, and recovers', async () => {
      await setUpAdmin();
      for (let i = 0; i < 5; i++) {
        expect((await login(new TestClient(app), 'kallum', `wrong ${i}`)).statusCode).toBe(401);
      }

      const blocked = await login(new TestClient(app), 'kallum', ADMIN.password);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ error: 'too_many_attempts' });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.headers['set-cookie']).toBeUndefined();

      t.clock.advance(15 * MINUTE + 1000);
      expect((await login(new TestClient(app), 'kallum', ADMIN.password)).statusCode).toBe(200);
    });

    it('treats unknown usernames the same way', async () => {
      for (let i = 0; i < 5; i++) await login(new TestClient(app), 'ghost', 'wrong password');
      const res = await login(new TestClient(app), 'GHOST', 'wrong password');
      expect(res.statusCode).toBe(429);
    });

    it('blocks an IP after 10 failures across usernames', async () => {
      await setUpAdmin();
      const attempt = (identifier: string, password = 'wrong password') =>
        new TestClient(app).post(
          '/api/auth/login',
          { identifier, password },
          { csrf: false, ip: '203.0.113.9' },
        );
      for (let i = 0; i < 10; i++) expect((await attempt(`user${i}`)).statusCode).toBe(401);

      expect((await attempt('kallum', ADMIN.password)).statusCode).toBe(429);
      // Another address is unaffected.
      expect(
        (
          await new TestClient(app).post(
            '/api/auth/login',
            { identifier: 'kallum', password: ADMIN.password },
            { csrf: false, ip: '203.0.113.10' },
          )
        ).statusCode,
      ).toBe(200);
    });

    it('forgets earlier failures after a successful login', async () => {
      await setUpAdmin();
      // Two rounds: the IP's own failure count (10 per window) is not reset by a success.
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 4; i++) await login(new TestClient(app), 'kallum', 'wrong password');
        expect((await login(new TestClient(app), 'kallum', ADMIN.password)).statusCode).toBe(200);
      }
    });
  });

  describe('invites', () => {
    it('lets an admin invite a member, who then sets a password and is logged in', async () => {
      const admin = await setUpAdmin();
      const res = await admin.post('/api/invites', {
        name: 'Sam',
        username: 'sam',
        email: 'sam@example.com',
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<Json>();
      expect(body.member).toMatchObject({ username: 'sam', role: 'member', pending: true });
      expect(body.invite.url).toBe(`http://localhost:80/invite/${body.invite.token}`);
      expect(Date.parse(body.invite.expiresAt) - t.clock.now().getTime()).toBe(7 * DAY);

      // The page can look up who the link is for, anonymously.
      const info = await new TestClient(app).get(`/api/invites/${body.invite.token}`);
      expect(info.json()).toEqual({
        name: 'Sam',
        username: 'sam',
        householdName: 'The Burgins',
        expiresAt: body.invite.expiresAt,
      });

      const sam = new TestClient(app);
      const accepted = await sam.post(
        `/api/invites/${body.invite.token}/accept`,
        { password: 'sams long password' },
        { csrf: false },
      );
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json<Json>().member).toMatchObject({ username: 'sam', pending: false });
      expect((await sam.get('/api/auth/me')).statusCode).toBe(200);

      // Later they can log in normally.
      expect((await login(new TestClient(app), 'sam', 'sams long password')).statusCode).toBe(200);
    });

    it('builds links from PUBLIC_BASE_URL when configured', async () => {
      t = createTestApp(handle, { publicBaseUrl: 'https://tracker.example' });
      app = t.app;
      const admin = await setUpAdmin();
      const res = await admin.post('/api/invites', { name: 'Sam', username: 'sam' });
      expect(res.json<Json>().invite.url).toMatch(/^https:\/\/tracker\.example\/invite\/.{20,}$/);
    });

    it('stores only a hash of the token', async () => {
      const admin = await setUpAdmin();
      const token = await invite(admin);
      const [row] = await handle.db.select().from(passwordToken);
      expect(row?.id).toBe(createHash('sha256').update(token).digest('hex'));
      expect(row?.purpose).toBe('invite');
    });

    it('only works once', async () => {
      const admin = await setUpAdmin();
      const token = await invite(admin);
      const accept = (password: string) =>
        new TestClient(app).post(`/api/invites/${token}/accept`, { password }, { csrf: false });

      expect((await accept('first password here')).statusCode).toBe(200);
      const second = await accept('second password here');
      expect(second.statusCode).toBe(410);
      expect(second.json()).toMatchObject({ error: 'link_expired' });
      expect((await new TestClient(app).get(`/api/invites/${token}`)).statusCode).toBe(410);

      // The first password is the one that stuck.
      expect((await login(new TestClient(app), 'sam', 'first password here')).statusCode).toBe(200);
      expect((await login(new TestClient(app), 'sam', 'second password here')).statusCode).toBe(
        401,
      );
    });

    it('lets only one of several simultaneous acceptances win', async () => {
      const admin = await setUpAdmin();
      const token = await invite(admin);
      const results = await Promise.all(
        [1, 2, 3].map((n) =>
          new TestClient(app).post(
            `/api/invites/${token}/accept`,
            { password: `password number ${n}` },
            { csrf: false },
          ),
        ),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 410, 410]);
    });

    it('expires after 7 days', async () => {
      const admin = await setUpAdmin();
      const token = await invite(admin);

      t.clock.advance(7 * DAY + MINUTE);
      expect((await new TestClient(app).get(`/api/invites/${token}`)).statusCode).toBe(410);
      const res = await new TestClient(app).post(
        `/api/invites/${token}/accept`,
        { password: 'a perfectly fine password' },
        { csrf: false },
      );
      expect(res.statusCode).toBe(410);
    });

    it('answers 404 for an unknown token and for the wrong kind of link', async () => {
      const admin = await setUpAdmin();
      const token = await invite(admin);
      const anon = new TestClient(app);

      expect((await anon.get('/api/invites/nope')).statusCode).toBe(404);
      expect((await anon.get(`/api/password-resets/${token}`)).statusCode).toBe(404);
      const res = await anon.post(
        `/api/password-resets/${token}`,
        { password: 'a perfectly fine password' },
        { csrf: false },
      );
      expect(res.statusCode).toBe(404);
    });

    it('rejects a weak password without using the link up', async () => {
      const admin = await setUpAdmin();
      const token = await invite(admin);
      const anon = new TestClient(app);

      expect(
        (await anon.post(`/api/invites/${token}/accept`, { password: 'short' }, { csrf: false }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await anon.post(
            `/api/invites/${token}/accept`,
            { password: 'long enough now' },
            { csrf: false },
          )
        ).statusCode,
      ).toBe(200);
    });

    it('is for admins only: members get 403 and anonymous callers 401', async () => {
      const admin = await setUpAdmin();
      const sam = await addMember(admin);
      const body = { name: 'Alex', username: 'alex' };

      expect((await sam.post('/api/invites', body)).statusCode).toBe(403);
      expect(
        (await new TestClient(app).post('/api/invites', body, { csrf: false })).statusCode,
      ).toBe(401);
      expect(await handle.db.select().from(member)).toHaveLength(2);
    });

    it('rejects duplicate usernames (any case) and emails', async () => {
      const admin = await setUpAdmin();
      await invite(admin);

      const sameName = await admin.post('/api/invites', { name: 'Other', username: 'SAM' });
      expect(sameName.statusCode).toBe(409);
      expect(sameName.json()).toMatchObject({ error: 'username_taken' });

      const adminName = await admin.post('/api/invites', { name: 'Other', username: 'Kallum' });
      expect(adminName.statusCode).toBe(409);

      const sameEmail = await admin.post('/api/invites', {
        name: 'Other',
        username: 'other',
        email: 'SAM@example.com',
      });
      expect(sameEmail.statusCode).toBe(409);
      expect(sameEmail.json()).toMatchObject({ error: 'email_taken' });

      expect(await handle.db.select().from(member)).toHaveLength(2);
    });

    it('can invite another admin', async () => {
      const admin = await setUpAdmin();
      const second = await addMember(admin, { username: 'jo', name: 'Jo', role: 'admin' });
      const res = await second.post('/api/invites', { name: 'Alex', username: 'alex' });
      expect(res.statusCode).toBe(201);
    });
  });

  describe('members', () => {
    it('lists the household for any member, including who is pending', async () => {
      const admin = await setUpAdmin();
      const sam = await addMember(admin);
      await invite(admin, { name: 'Alex', username: 'alex', email: 'alex@example.com' });

      const res = await sam.get('/api/members');
      expect(res.statusCode).toBe(200);
      expect(res.json<Json>().members).toEqual([
        expect.objectContaining({ username: 'alex', pending: true }),
        expect.objectContaining({ username: 'kallum', role: 'admin', pending: false }),
        expect.objectContaining({ username: 'sam', role: 'member', pending: false }),
      ]);
    });

    it('requires a session', async () => {
      expect((await new TestClient(app).get('/api/members')).statusCode).toBe(401);
    });

    it('only shows members of the caller’s own household', async () => {
      const admin = await setUpAdmin();
      const [other] = await handle.db.insert(household).values({ name: 'Elsewhere' }).returning();
      await handle.db.insert(member).values({
        householdId: other?.id as string,
        name: 'Stranger',
        username: 'stranger',
      });

      const names = (await admin.get('/api/members'))
        .json<Json>()
        .members.map((m: Json) => m.username);
      expect(names).toEqual(['kallum']);
    });
  });

  describe('admin password reset', () => {
    it('gives a one-time link, signs the member out, and replaces the old password', async () => {
      const admin = await setUpAdmin();
      const sam = await addMember(admin);
      const samId = (await sam.get('/api/auth/me')).json<Json>().member.id;
      const otherDevice = new TestClient(app);
      await login(otherDevice, 'sam', 'sams long password');

      const res = await admin.post(`/api/members/${samId}/password-reset`);
      expect(res.statusCode).toBe(200);
      const { purpose, link } = res.json<Json>();
      expect(purpose).toBe('reset');
      expect(link.url).toBe(`http://localhost:80/reset-password/${link.token}`);
      expect(Date.parse(link.expiresAt) - t.clock.now().getTime()).toBe(DAY);

      // Existing sessions end as soon as the reset is issued.
      expect((await sam.get('/api/auth/me')).statusCode).toBe(401);
      expect((await otherDevice.get('/api/auth/me')).statusCode).toBe(401);

      const info = await new TestClient(app).get(`/api/password-resets/${link.token}`);
      expect(info.json()).toMatchObject({ username: 'sam', householdName: 'The Burgins' });

      const reset = new TestClient(app);
      const done = await reset.post(
        `/api/password-resets/${link.token}`,
        { password: 'brand new password' },
        { csrf: false },
      );
      expect(done.statusCode).toBe(200);
      expect((await reset.get('/api/auth/me')).statusCode).toBe(200);

      expect((await login(new TestClient(app), 'sam', 'sams long password')).statusCode).toBe(401);
      expect((await login(new TestClient(app), 'sam', 'brand new password')).statusCode).toBe(200);

      // One time only.
      const again = await new TestClient(app).post(
        `/api/password-resets/${link.token}`,
        { password: 'yet another password' },
        { csrf: false },
      );
      expect(again.statusCode).toBe(410);
    });

    it('ends sessions opened between issuing and using the link', async () => {
      const admin = await setUpAdmin();
      const sam = await addMember(admin);
      const samId = (await sam.get('/api/auth/me')).json<Json>().member.id;
      const { link } = (await admin.post(`/api/members/${samId}/password-reset`)).json<Json>();

      // Someone with the old password logs in before the link is used.
      const intruder = new TestClient(app);
      expect((await login(intruder, 'sam', 'sams long password')).statusCode).toBe(200);
      await new TestClient(app).post(
        `/api/password-resets/${link.token}`,
        { password: 'brand new password' },
        { csrf: false },
      );
      expect((await intruder.get('/api/auth/me')).statusCode).toBe(401);
    });

    it('voids an earlier link when a new one is issued', async () => {
      const admin = await setUpAdmin();
      const sam = await addMember(admin);
      const samId = (await sam.get('/api/auth/me')).json<Json>().member.id;
      const first = (await admin.post(`/api/members/${samId}/password-reset`)).json<Json>().link;
      const second = (await admin.post(`/api/members/${samId}/password-reset`)).json<Json>().link;

      expect(
        (await new TestClient(app).get(`/api/password-resets/${first.token}`)).statusCode,
      ).toBe(404);
      expect(
        (await new TestClient(app).get(`/api/password-resets/${second.token}`)).statusCode,
      ).toBe(200);
    });

    it('expires after a day', async () => {
      const admin = await setUpAdmin();
      const sam = await addMember(admin);
      const samId = (await sam.get('/api/auth/me')).json<Json>().member.id;
      const { link } = (await admin.post(`/api/members/${samId}/password-reset`)).json<Json>();

      t.clock.advance(DAY + MINUTE);
      expect((await new TestClient(app).get(`/api/password-resets/${link.token}`)).statusCode).toBe(
        410,
      );
    });

    it('issues a fresh invite for a member who never accepted the first one', async () => {
      const admin = await setUpAdmin();
      const oldToken = await invite(admin);
      const samId = (await admin.get('/api/members'))
        .json<Json>()
        .members.find((m: Json) => m.username === 'sam').id;

      t.clock.advance(8 * DAY);
      await login(admin, 'kallum', ADMIN.password); // the admin's own session has lapsed too
      const res = await admin.post(`/api/members/${samId}/password-reset`);
      const { purpose, link } = res.json<Json>();
      expect(purpose).toBe('invite');
      expect(link.url).toContain('/invite/');

      expect((await new TestClient(app).get(`/api/invites/${oldToken}`)).statusCode).toBe(404);
      const accepted = await new TestClient(app).post(
        `/api/invites/${link.token}/accept`,
        { password: 'a perfectly fine password' },
        { csrf: false },
      );
      expect(accepted.statusCode).toBe(200);
    });

    it('is admin-only and needs a session', async () => {
      const admin = await setUpAdmin();
      const sam = await addMember(admin);
      const adminId = (await admin.get('/api/auth/me')).json<Json>().member.id;
      const samId = (await sam.get('/api/auth/me')).json<Json>().member.id;

      expect((await sam.post(`/api/members/${adminId}/password-reset`)).statusCode).toBe(403);
      expect((await sam.post(`/api/members/${samId}/password-reset`)).statusCode).toBe(403);
      expect(
        (
          await new TestClient(app).post(`/api/members/${samId}/password-reset`, undefined, {
            csrf: false,
          })
        ).statusCode,
      ).toBe(401);
      // Sam is still signed in: nothing happened.
      expect((await sam.get('/api/auth/me')).statusCode).toBe(200);
    });

    it('refuses to reset yourself, an unknown member, or another household’s member', async () => {
      const admin = await setUpAdmin();
      const adminId = (await admin.get('/api/auth/me')).json<Json>().member.id;
      const [other] = await handle.db.insert(household).values({ name: 'Elsewhere' }).returning();
      const [stranger] = await handle.db
        .insert(member)
        .values({
          householdId: other?.id as string,
          name: 'S',
          username: 'stranger',
          passwordHash: 'x',
        })
        .returning();

      expect((await admin.post(`/api/members/${adminId}/password-reset`)).statusCode).toBe(400);
      expect(
        (await admin.post('/api/members/00000000-0000-4000-8000-000000000000/password-reset'))
          .statusCode,
      ).toBe(404);
      expect((await admin.post(`/api/members/${stranger?.id}/password-reset`)).statusCode).toBe(
        404,
      );
      expect((await admin.post('/api/members/not-a-uuid/password-reset')).statusCode).toBe(400);
    });
  });

  describe('changing your own password', () => {
    it('needs the current password, keeps this session and ends the others', async () => {
      const client = await setUpAdmin();
      const other = new TestClient(app);
      await login(other, 'kallum', ADMIN.password);

      const wrong = await client.post('/api/auth/password', {
        currentPassword: 'definitely wrong',
        newPassword: 'a shiny new password',
      });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json()).toMatchObject({ error: 'wrong_password' });

      const ok = await client.post('/api/auth/password', {
        currentPassword: ADMIN.password,
        newPassword: 'a shiny new password',
      });
      expect(ok.statusCode).toBe(200);

      expect((await client.get('/api/auth/me')).statusCode).toBe(200);
      expect((await other.get('/api/auth/me')).statusCode).toBe(401);
      expect((await login(new TestClient(app), 'kallum', ADMIN.password)).statusCode).toBe(401);
      expect((await login(new TestClient(app), 'kallum', 'a shiny new password')).statusCode).toBe(
        200,
      );
    });

    it('rejects a too-short new password and needs a session and CSRF token', async () => {
      const client = await setUpAdmin();
      const body = { currentPassword: ADMIN.password, newPassword: 'short' };
      expect((await client.post('/api/auth/password', body)).statusCode).toBe(400);
      expect(
        (
          await client.post(
            '/api/auth/password',
            { ...body, newPassword: 'long enough now' },
            { csrf: false },
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (await new TestClient(app).post('/api/auth/password', body, { csrf: false })).statusCode,
      ).toBe(401);
    });

    it('rate limits wrong current passwords', async () => {
      const client = await setUpAdmin();
      const attempt = () =>
        client.post('/api/auth/password', {
          currentPassword: 'definitely wrong',
          newPassword: 'a shiny new password',
        });
      for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(400);
      expect((await attempt()).statusCode).toBe(429);
    });
  });

  describe('responses', () => {
    it('never contain password hashes, tokens hashes or iCal secrets', async () => {
      const admin = await setUpAdmin();
      const responses = [await admin.get('/api/auth/me'), await admin.get('/api/members')];
      const inviteRes = await admin.post('/api/invites', { name: 'Sam', username: 'sam' });
      const token = inviteRes.json<Json>().invite.token as string;
      responses.push(inviteRes, await new TestClient(app).get(`/api/invites/${token}`));
      const sam = new TestClient(app);
      responses.push(
        await sam.post(
          `/api/invites/${token}/accept`,
          { password: 'sams long password' },
          { csrf: false },
        ),
        await login(new TestClient(app), 'sam', 'sams long password'),
      );

      const secrets = [
        ...(await handle.db.select().from(member)).flatMap((m) => [m.passwordHash, m.icalToken]),
        ...(await handle.db.select().from(session)).map((s) => s.id),
        ...(await handle.db.select().from(passwordToken)).map((p) => p.id),
        'passwordHash',
        'password_hash',
        'icalToken',
        '$argon2',
      ];
      for (const res of responses) {
        for (const secret of secrets) {
          expect(res.body).not.toContain(secret as string);
        }
      }
    });

    it('uses one error shape for 404s', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found', message: 'Not found' });
    });
  });

  it('deleting a member removes their sessions and links (cascade)', async () => {
    const admin = await setUpAdmin();
    const sam = await addMember(admin);
    expect(sam.cookie).toBeDefined();
    const [row] = await handle.db.select().from(member).where(eq(member.username, 'sam'));
    await handle.db.delete(member).where(eq(member.id, row?.id as string));
    expect(await handle.db.select().from(session)).toHaveLength(1);
    expect(await handle.db.select().from(passwordToken)).toHaveLength(0);
  });
});
