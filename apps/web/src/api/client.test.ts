import { describe, expect, it, vi } from 'vitest';
import { apiError, fakeServer, json } from '../test-util.js';
import { createApiClient } from './client.js';
import { ApiError, describeError } from './errors.js';

const SETUP = 'GET /api/setup';

function clientFor(server: ReturnType<typeof fakeServer>, extra = {}) {
  return createApiClient({ fetch: server.fetch, getCsrfToken: () => 'csrf-1', ...extra });
}

describe('createApiClient', () => {
  it('sends the CSRF token and a JSON content type on mutating requests', async () => {
    const server = fakeServer({
      'POST /api/auth/password': json({ ok: true }),
      'POST /api/auth/logout': json({ ok: true }),
    });
    const api = clientFor(server);

    await api.POST('/api/auth/password', { body: { currentPassword: 'a', newPassword: 'b' } });
    await api.POST('/api/auth/logout');

    const [password, logout] = server.calls;
    expect(password?.headers.get('x-csrf-token')).toBe('csrf-1');
    expect(password?.headers.get('content-type')).toContain('application/json');
    expect(password?.body).toEqual({ currentPassword: 'a', newPassword: 'b' });
    // A bodiless POST is still sent as JSON, which the api accepts.
    expect(logout?.headers.get('x-csrf-token')).toBe('csrf-1');
    expect(logout?.headers.get('content-type')).toContain('application/json');
  });

  it('does not send the CSRF token on GET', async () => {
    const server = fakeServer({ [SETUP]: json({ needsSetup: false }) });
    const { data } = await clientFor(server).GET('/api/setup');

    expect(data).toEqual({ needsSetup: false });
    expect(server.calls[0]?.headers.has('x-csrf-token')).toBe(false);
  });

  it('omits the header when there is no session yet', async () => {
    const server = fakeServer({ 'POST /api/auth/login': json({}) });
    const api = createApiClient({ fetch: server.fetch, getCsrfToken: () => undefined });

    await api.POST('/api/auth/login', { body: { identifier: 'a', password: 'b' } });

    expect(server.calls[0]?.headers.has('x-csrf-token')).toBe(false);
    expect(server.calls[0]?.headers.get('content-type')).toContain('application/json');
  });

  it('turns { error, message } responses into an ApiError', async () => {
    const server = fakeServer({ [SETUP]: apiError(410, 'gone', 'This link has expired') });

    const failure = await clientFor(server)
      .GET('/api/setup')
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 410, code: 'gone', message: 'This link has expired' });
  });

  it('reads Retry-After from rate-limited responses', async () => {
    const server = fakeServer({
      [SETUP]: json({ error: 'too_many_attempts', message: 'Slow down.' }, 429, {
        'retry-after': '90',
      }),
    });

    const failure = await clientFor(server)
      .GET('/api/setup')
      .catch((e: unknown) => e);

    expect(failure).toMatchObject({ status: 429, retryAfter: 90 });
    expect(describeError(failure)).toBe('Slow down. Try again in 2 minutes.');
  });

  it('copes with error bodies that are not our JSON', async () => {
    const server = fakeServer({
      [SETUP]: new Response('<html>Bad gateway</html>', { status: 502 }),
    });

    const failure = await clientFor(server)
      .GET('/api/setup')
      .catch((e: unknown) => e);

    expect(failure).toMatchObject({ status: 502, code: 'http_error' });
    expect((failure as ApiError).message).toContain('502');
  });

  it('maps a network failure to status 0', async () => {
    const api = createApiClient({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });

    const failure = await api.GET('/api/setup').catch((e: unknown) => e);

    expect(failure).toMatchObject({ status: 0, code: 'network_error' });
    expect(describeError(failure)).toContain('Could not reach the server');
  });

  it('calls onUnauthorized for a 401 before throwing', async () => {
    const onUnauthorized = vi.fn();
    const server = fakeServer({ [SETUP]: apiError(401, 'unauthorized', 'Log in to continue') });

    await expect(clientFor(server, { onUnauthorized }).GET('/api/setup')).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('sends cookies to the same origin only', async () => {
    const server = fakeServer({ [SETUP]: json({ needsSetup: false }) });
    let credentials: string | undefined;
    const api = createApiClient({
      fetch: (request) => {
        credentials = (request as Request).credentials;
        return server.fetch(request);
      },
    });

    await api.GET('/api/setup');

    expect(credentials).toBe('same-origin');
  });
});

describe('describeError', () => {
  it('hides unexpected errors behind a generic message', () => {
    expect(describeError(new Error('boom'))).toBe('Something went wrong. Please try again.');
  });

  it('counts short waits in seconds', () => {
    const err = new ApiError(429, 'too_many_attempts', 'Too many attempts.', 30);
    expect(describeError(err)).toBe('Too many attempts. Try again in 30 seconds.');
  });
});
