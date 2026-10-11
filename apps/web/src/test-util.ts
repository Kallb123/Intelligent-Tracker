import type { SessionInfo } from '@tracker/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { createMemoryHistory, type Router } from 'vue-router';
import App from './App.vue';
import { setApi } from './api/index.js';
import { createAppRouter } from './router.js';
import { createSessionApi } from './stores/session.js';

/** A request the fake server saw, with the body already parsed. */
export interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

export type Handler = Response | ((call: Call) => Response | Promise<Response>);

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

export const apiError = (status: number, error: string, message: string) =>
  json({ error, message }, status);

/**
 * An in-memory stand-in for the api: handlers are keyed `"METHOD /path"`. Anything unhandled
 * answers 500 and is listed in `unhandled`, so a test fails loudly instead of hanging.
 */
export function fakeServer(handlers: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const unhandled: string[] = [];

  const fetchFn = (async (input: Request) => {
    const { pathname } = new URL(input.url);
    const text = await input.clone().text();
    const call: Call = {
      method: input.method,
      path: pathname,
      headers: input.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    calls.push(call);
    const handler = handlers[`${call.method} ${call.path}`];
    if (!handler) {
      unhandled.push(`${call.method} ${call.path}`);
      return apiError(500, 'unhandled', `No fake handler for ${call.method} ${call.path}`);
    }
    return typeof handler === 'function' ? handler(call) : handler.clone();
  }) as typeof fetch;

  return {
    handlers,
    calls,
    unhandled,
    fetch: fetchFn,
    callsTo: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key),
  };
}

export type FakeServer = ReturnType<typeof fakeServer>;

export const session = (overrides: Partial<SessionInfo['member']> = {}): SessionInfo => ({
  member: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Alex',
    username: 'alex',
    email: null,
    role: 'admin',
    pending: false,
    ...overrides,
  },
  household: {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'The Smiths',
    timezone: 'Europe/London',
    locale: 'en-GB',
  },
  csrfToken: 'csrf-abc',
});

/** Fresh Pinia + a session-wired api client talking to `server`. */
export function setupApp(server: FakeServer): Pinia {
  const pinia = createPinia();
  setActivePinia(pinia);
  setApi(createSessionApi(server.fetch));
  return pinia;
}

/** Mounts the whole app (router, PrimeVue, pages) at `path`, as `main.ts` does. */
export async function mountApp(server: FakeServer, path: string) {
  const pinia = setupApp(server);
  const router: Router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const wrapper = mount(App, {
    global: { plugins: [pinia, router, PrimeVue] },
    attachTo: document.body,
  });
  await flushPromises();
  return { wrapper, router, pinia };
}
