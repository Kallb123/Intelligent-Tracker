import { createDb, runMigrations, type DbHandle } from '@tracker/db';
import { createTestDatabase, type TestDatabase } from '@tracker/db/test-db';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { PasswordParams } from './auth/passwords.js';
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
    method: 'GET' | 'POST',
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
}

export const ADMIN = {
  householdName: 'The Burgins',
  name: 'Kallum',
  username: 'kallum',
  email: 'kallum@example.com',
  password: 'correct horse battery',
};
