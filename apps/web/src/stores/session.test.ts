import { beforeEach, describe, expect, it } from 'vitest';
import { apiError, fakeServer, json, session, setupApp } from '../test-util.js';
import { useSessionStore } from './session.js';

const ME = 'GET /api/auth/me';
const SETUP = 'GET /api/setup';
const unauthorized = () => apiError(401, 'unauthorized', 'Log in to continue');

function store(handlers: Parameters<typeof fakeServer>[0]) {
  const server = fakeServer(handlers);
  setupApp(server);
  return { server, session: useSessionStore() };
}

describe('session store', () => {
  beforeEach(() => document.body.replaceChildren());

  it('loads the session on bootstrap and skips the setup check', async () => {
    const { server, session: s } = store({ [ME]: json(session()) });

    await s.bootstrap();

    expect(s.isLoggedIn).toBe(true);
    expect(s.isAdmin).toBe(true);
    expect(s.household?.name).toBe('The Smiths');
    expect(s.csrfToken).toBe('csrf-abc');
    expect(server.callsTo(SETUP)).toHaveLength(0);
  });

  it('is logged out on 401 and asks whether setup is needed', async () => {
    const { session: s } = store({ [ME]: unauthorized(), [SETUP]: json({ needsSetup: true }) });

    await s.bootstrap();

    expect(s.isLoggedIn).toBe(false);
    expect(s.isAdmin).toBe(false);
    expect(s.needsSetup).toBe(true);
    expect(s.timeZone).toBe('Europe/London');
  });

  it('only bootstraps once, unless forced', async () => {
    const { server, session: s } = store({ [ME]: json(session()) });

    await Promise.all([s.bootstrap(), s.bootstrap()]);
    await s.bootstrap();
    expect(server.callsTo(ME)).toHaveLength(1);

    await s.bootstrap(true);
    expect(server.callsTo(ME)).toHaveLength(2);
  });

  it('records an api that cannot be reached instead of looking logged out', async () => {
    const { session: s } = store({ [ME]: apiError(502, 'bad_gateway', 'Bad gateway') });

    await s.bootstrap();

    expect(s.bootError?.status).toBe(502);
    expect(s.isLoggedIn).toBe(false);
  });

  it('records a failing setup check too', async () => {
    const { session: s } = store({
      [ME]: unauthorized(),
      [SETUP]: apiError(500, 'internal_error', 'Boom'),
    });

    await s.bootstrap();

    expect(s.bootError?.message).toBe('Boom');
  });

  it('logs in, then sends its CSRF token on writes', async () => {
    const { server, session: s } = store({
      'POST /api/auth/login': json(session({ role: 'member' })),
      'POST /api/auth/logout': json({ ok: true }),
    });

    await s.login({ identifier: 'alex', password: 'pw', remember: true });
    expect(s.isLoggedIn).toBe(true);
    expect(s.isAdmin).toBe(false);
    expect(s.needsSetup).toBe(false);
    expect(server.calls[0]?.body).toEqual({ identifier: 'alex', password: 'pw', remember: true });

    await s.logout();
    expect(server.callsTo('POST /api/auth/logout')[0]?.headers.get('x-csrf-token')).toBe(
      'csrf-abc',
    );
    expect(s.isLoggedIn).toBe(false);
  });

  it('keeps the error and stays logged out when login fails', async () => {
    const { session: s } = store({
      'POST /api/auth/login': apiError(401, 'unauthorized', 'Incorrect username or password'),
    });

    await expect(s.login({ identifier: 'a', password: 'b' })).rejects.toMatchObject({
      status: 401,
      message: 'Incorrect username or password',
    });
    expect(s.isLoggedIn).toBe(false);
  });

  it('treats a 401 on logout as already logged out, but surfaces other failures', async () => {
    const { session: s } = store({
      'POST /api/auth/login': json(session()),
      'POST /api/auth/logout': unauthorized(),
    });
    await s.login({ identifier: 'a', password: 'b' });
    await s.logout();
    expect(s.isLoggedIn).toBe(false);

    const failing = store({
      'POST /api/auth/login': json(session()),
      'POST /api/auth/logout': apiError(500, 'internal_error', 'Boom'),
    });
    await failing.session.login({ identifier: 'a', password: 'b' });
    await expect(failing.session.logout()).rejects.toMatchObject({ status: 500 });
    expect(failing.session.isLoggedIn).toBe(true);
  });

  it('creates the household on setup and starts the session', async () => {
    const { server, session: s } = store({ 'POST /api/setup': json(session(), 201) });

    await s.setup({
      householdName: 'The Smiths',
      name: 'Alex',
      username: 'alex',
      password: 'long-enough-pw',
    });

    expect(s.isLoggedIn).toBe(true);
    expect(s.needsSetup).toBe(false);
    expect(server.calls[0]?.body).toMatchObject({ householdName: 'The Smiths' });
  });

  it('accepts an invite and resets a password through their own endpoints', async () => {
    const accept = store({ 'POST /api/invites/tok1/accept': json(session({ role: 'member' })) });
    await accept.session.acceptInvite('tok1', { password: 'long-enough-pw', remember: false });
    expect(accept.session.member?.role).toBe('member');
    expect(accept.server.calls[0]?.body).toEqual({ password: 'long-enough-pw', remember: false });

    const reset = store({ 'POST /api/password-resets/tok2': json(session()) });
    await reset.session.resetPassword('tok2', { password: 'long-enough-pw' });
    expect(reset.session.isLoggedIn).toBe(true);
  });

  it('drops the session when the api reports it has ended', async () => {
    const { session: s } = store({
      'POST /api/auth/login': json(session()),
      'GET /api/members': unauthorized(),
    });
    await s.login({ identifier: 'a', password: 'b' });

    const { getApi } = await import('../api/index.js');
    await expect(getApi().GET('/api/members')).rejects.toMatchObject({ status: 401 });

    expect(s.isLoggedIn).toBe(false);
  });
});
