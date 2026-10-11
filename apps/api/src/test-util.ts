import { createDb, household, member, runMigrations, type DbHandle } from '@tracker/db';
import { createTestDatabase, type TestDatabase } from '@tracker/db/test-db';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { hashPassword, type PasswordParams } from './auth/passwords.js';
import type { AuthConfig } from './config.js';
import { buildServer } from './server.js';

/** The cheapest Argon2id settings, so tests that hash many passwords stay fast. */
export const FAST_PASSWORD_PARAMS: PasswordParams = {
  memoryKiB: 8,
  iterations: 1,
  parallelism: 1,
};

/** A controllable clock for expiry and rate-limit tests. */
export class TestClock {
  private ms = Date.parse('2026-03-01T12:00:00Z');
  readonly now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
  /** Jumps to an ISO instant. */
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
}

/** A migrated, throwaway database for one test file. */
export async function createMigratedDatabase(adminUrl: string) {
  const testDb: TestDatabase = await createTestDatabase(adminUrl);
  await runMigrations({ databaseUrl: testDb.url });
  const handle: DbHandle = createDb(testDb.url);
  return {
    handle,
    async close() {
      await handle.close();
      await testDb.drop();
    },
  };
}

export interface TestApp {
  app: FastifyInstance;
  clock: TestClock;
}

export function createTestApp(handle: DbHandle, auth: Partial<AuthConfig> = {}): TestApp {
  const clock = new TestClock();
  const app = buildServer({
    db: handle.db,
    auth: { passwordParams: FAST_PASSWORD_PARAMS, clock: clock.now, ...auth },
  });
  return { app, clock };
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** `false` omits the CSRF header; a string sends that value instead of the real one. */
  csrf?: boolean | string;
  /** Client IP seen by the server, for per-IP rate limit tests. */
  ip?: string;
}

/**
 * A minimal cookie-keeping browser stand-in over `app.inject()`. It remembers the session
 * cookie and the CSRF token from the last session-starting response.
 */
export class TestClient {
  cookie: string | undefined;
  csrfToken: string | undefined;
  /** Set-Cookie attributes of the most recent session cookie. */
  lastCookie: LightMyRequestResponse['cookies'][number] | undefined;

  constructor(private readonly app: FastifyInstance) {}

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    options: RequestOptions = {},
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { ...options.headers };
    if (this.cookie) headers['cookie'] = this.cookie;
    const csrf = options.csrf ?? true;
    const token = typeof csrf === 'string' ? csrf : csrf ? this.csrfToken : undefined;
    if (token) headers['x-csrf-token'] = token;
    const res = await this.app.inject({
      method,
      url,
      headers,
      ...(options.ip ? { remoteAddress: options.ip } : {}),
      ...(options.body !== undefined ? { payload: options.body as object } : {}),
    });

    for (const c of res.cookies) {
      if (c.name === 'session' || c.name === '__Host-session') {
        this.lastCookie = c;
        this.cookie = c.value ? `${c.name}=${c.value}` : undefined;
      }
    }
    const body = res.headers['content-type']?.toString().includes('json')
      ? (res.json() as { csrfToken?: string })
      : undefined;
    if (body?.csrfToken) this.csrfToken = body.csrfToken;
    return res;
  }

  get(url: string, options?: RequestOptions) {
    return this.request('GET', url, options);
  }
  post(url: string, body?: unknown, options: RequestOptions = {}) {
    return this.request('POST', url, { ...options, ...(body !== undefined ? { body } : {}) });
  }
  patch(url: string, body?: unknown, options: RequestOptions = {}) {
    return this.request('PATCH', url, { ...options, ...(body !== undefined ? { body } : {}) });
  }
  delete(url: string, options?: RequestOptions) {
    return this.request('DELETE', url, options);
  }
}

export const ADMIN = {
  householdName: 'The Burgins',
  name: 'Kallum',
  username: 'kallum',
  email: 'kallum@example.com',
  password: 'correct horse battery',
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Runs first-run setup and returns the logged-in admin. */
export async function setUpAdmin(app: FastifyInstance, overrides: Json = {}): Promise<TestClient> {
  const admin = new TestClient(app);
  const res = await admin.post('/api/setup', { ...ADMIN, ...overrides }, { csrf: false });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.body}`);
  return admin;
}

/** Invites a member, has them accept, and returns their logged-in client and member id. */
export async function addMember(
  app: FastifyInstance,
  admin: TestClient,
  body: Json = {},
): Promise<{ client: TestClient; id: string }> {
  const invited = await admin.post('/api/invites', {
    name: 'Sam',
    username: 'sam',
    email: 'sam@example.com',
    ...body,
  });
  if (invited.statusCode !== 201) throw new Error(`invite failed: ${invited.body}`);
  const client = new TestClient(app);
  const accepted = await client.post(
    `/api/invites/${invited.json<Json>().invite.token}/accept`,
    { password: 'sams long password' },
    { csrf: false },
  );
  if (accepted.statusCode !== 200) throw new Error(`accept failed: ${accepted.body}`);
  return { client, id: invited.json<Json>().member.id };
}

/** A member of a second, unrelated household, logged in. */
export async function addOutsider(app: FastifyInstance, handle: DbHandle) {
  const [h] = await handle.db.insert(household).values({ name: 'Elsewhere' }).returning();
  const [m] = await handle.db
    .insert(member)
    .values({
      householdId: h?.id as string,
      name: 'Stranger',
      username: 'stranger',
      passwordHash: await hashPassword('strangers long password', FAST_PASSWORD_PARAMS),
    })
    .returning();
  const client = new TestClient(app);
  const res = await client.post(
    '/api/auth/login',
    { identifier: 'stranger', password: 'strangers long password' },
    { csrf: false },
  );
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  return { client, householdId: h?.id as string, memberId: m?.id as string };
}
