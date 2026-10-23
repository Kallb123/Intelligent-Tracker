import { createMemoryHistory, type Router } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setUpdatePending } from './pwa.js';
import { createAppRouter, safeRedirect } from './router.js';
import { apiError, fakeServer, json, session, setupApp, type Handler } from './test-util.js';

const loggedOut: Record<string, Handler> = {
  'GET /api/auth/me': apiError(401, 'unauthorized', 'Log in to continue'),
  'GET /api/setup': json({ needsSetup: false }),
};
const loggedIn: Record<string, Handler> = { 'GET /api/auth/me': json(session()) };

async function visit(handlers: Record<string, Handler>, path: string): Promise<Router> {
  setupApp(fakeServer(handlers));
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  return router;
}

describe('router guards', () => {
  it('sends everything to /setup while the household needs setting up', async () => {
    const handlers = { ...loggedOut, 'GET /api/setup': json({ needsSetup: true }) };

    expect((await visit(handlers, '/')).currentRoute.value.name).toBe('setup');
    expect((await visit(handlers, '/login')).currentRoute.value.name).toBe('setup');
    expect((await visit(handlers, '/invite/abc')).currentRoute.value.name).toBe('setup');
    expect((await visit(handlers, '/setup')).currentRoute.value.name).toBe('setup');
  });

  it('closes /setup once the household exists', async () => {
    expect((await visit(loggedOut, '/setup')).currentRoute.value.name).toBe('login');
    expect((await visit(loggedIn, '/setup')).currentRoute.value.name).toBe('home');
  });

  it('sends logged-out visitors to /login with a redirect back', async () => {
    const people = (await visit(loggedOut, '/people')).currentRoute.value;
    expect(people.name).toBe('login');
    expect(people.query).toEqual({ redirect: '/people' });

    // No pointless ?redirect=/ for the home page.
    expect((await visit(loggedOut, '/')).currentRoute.value.fullPath).toBe('/login');
  });

  it('lets logged-out visitors reach the public pages', async () => {
    const invite = (await visit(loggedOut, '/invite/abc')).currentRoute.value;
    expect([invite.name, invite.params['token']]).toEqual(['invite', 'abc']);
    const reset = (await visit(loggedOut, '/reset-password/xyz')).currentRoute.value;
    expect([reset.name, reset.params['token']]).toEqual(['reset-password', 'xyz']);
    expect((await visit(loggedOut, '/login')).currentRoute.value.name).toBe('login');
  });

  it('shows members the app and keeps them off /login', async () => {
    expect((await visit(loggedIn, '/account')).currentRoute.value.name).toBe('account');
    expect((await visit(loggedIn, '/login')).currentRoute.value.fullPath).toBe('/');
    expect((await visit(loggedIn, '/login?redirect=/people')).currentRoute.value.fullPath).toBe(
      '/people',
    );
    expect(
      (await visit(loggedIn, '/login?redirect=//evil.example')).currentRoute.value.fullPath,
    ).toBe('/');
  });

  it('has the task pages behind login, with the editor on /tasks/new and /tasks/:id', async () => {
    const pages: [string, string][] = [
      ['/upcoming', 'upcoming'],
      ['/tasks', 'tasks'],
      ['/tasks/new', 'task-new'],
    ];
    for (const [path, name] of pages) {
      expect((await visit(loggedIn, path)).currentRoute.value.name, path).toBe(name);
      expect((await visit(loggedOut, path)).currentRoute.value.name, path).toBe('login');
    }

    const edit = (await visit(loggedIn, '/tasks/abc-123')).currentRoute.value;
    expect([edit.name, edit.params['id']]).toEqual(['task-edit', 'abc-123']);
    expect((await visit(loggedOut, '/tasks/abc-123')).currentRoute.value.query).toEqual({
      redirect: '/tasks/abc-123',
    });
  });

  it('shows unknown pages inside the app, behind login', async () => {
    expect((await visit(loggedIn, '/nope/nothing')).currentRoute.value.name).toBe('not-found');
    expect((await visit(loggedOut, '/nope')).currentRoute.value.name).toBe('login');
  });

  it('shows the unavailable page when the api cannot be reached', async () => {
    const handlers = { 'GET /api/auth/me': apiError(502, 'bad_gateway', 'Bad gateway') };

    expect((await visit(handlers, '/people')).currentRoute.value.name).toBe('unavailable');
    expect((await visit(handlers, '/unavailable')).currentRoute.value.name).toBe('unavailable');
    // Nothing is wrong, so there is nothing to show here.
    expect((await visit(loggedIn, '/unavailable')).currentRoute.value.name).toBe('home');
  });
});

describe('after a new version of the app has taken over', () => {
  const assign = vi.fn();
  afterEach(() => {
    setUpdatePending(false);
    assign.mockClear();
    vi.unstubAllGlobals();
  });

  it('loads the next page from the server instead of navigating inside the old one', async () => {
    const router = await visit(loggedIn, '/tasks');
    vi.stubGlobal('location', { ...window.location, assign });
    setUpdatePending();

    await router.push('/people?sort=name#top');

    expect(assign).toHaveBeenCalledExactlyOnceWith('/people?sort=name#top');
    // The client-side navigation is cancelled: the page stays as it was until the load replaces it.
    expect(router.currentRoute.value.fullPath).toBe('/tasks');
  });

  it('leaves the page alone until it navigates', async () => {
    const router = await visit(loggedIn, '/tasks');
    vi.stubGlobal('location', { ...window.location, assign });

    setUpdatePending();
    expect(assign).not.toHaveBeenCalled();
    expect(router.currentRoute.value.name).toBe('tasks');
  });

  it('navigates normally when no update is pending', async () => {
    const router = await visit(loggedIn, '/tasks');
    vi.stubGlobal('location', { ...window.location, assign });

    await router.push('/people');

    expect(assign).not.toHaveBeenCalled();
    expect(router.currentRoute.value.name).toBe('people');
  });
});

describe('safeRedirect', () => {
  it('only follows paths on this site', () => {
    expect(safeRedirect('/people')).toBe('/people');
    expect(safeRedirect('/people?x=1')).toBe('/people?x=1');
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '',
      undefined,
      ['/a'],
    ]) {
      expect(safeRedirect(bad)).toBe('/');
    }
  });
});
