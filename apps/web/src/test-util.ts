import type { SessionInfo } from '@tracker/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { vi, type Mock } from 'vitest';
import { createMemoryHistory, type Router } from 'vue-router';
import App from './App.vue';
import { setApi } from './api/index.js';
import { createAppRouter } from './router.js';
import { createSessionApi } from './stores/session.js';

/** A request the fake server saw, with the body already parsed. */
export interface Call {
  method: string;
  path: string;
  /** The query string without the `?`, such as `view=upcoming&days=90`. */
  search: string;
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
    const { pathname, search } = new URL(input.url);
    const text = await input.clone().text();
    const call: Call = {
      method: input.method,
      path: pathname,
      search: search.slice(1),
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
    awayUntil: null,
    telegramLinked: false,
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

/** A real-looking VAPID public key (65 bytes, URL-safe base64) for the fake server's push config. */
export const VAPID_KEY =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';

/** What `fakePushSupport` returns: the fake browser's parts, to set up and inspect. */
export interface FakePush {
  registration: { pushManager: FakePush['pushManager'] };
  pushManager: {
    getSubscription: Mock<() => Promise<FakeSubscription | null>>;
    subscribe: Mock<
      (options: {
        userVisibleOnly: boolean;
        applicationServerKey: Uint8Array;
      }) => Promise<FakeSubscription>
    >;
  };
  notification: Mock & {
    permission: NotificationPermission;
    requestPermission: Mock<() => Promise<NotificationPermission>>;
  };
  /** The browser's current subscription (null when not subscribed). */
  readonly subscription: FakeSubscription | null;
  /** Puts the test browser back as it was; call it after the test. */
  restore(): void;
}

/** A browser push subscription, as far as the app uses one. */
export interface FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON(): { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: Mock<() => Promise<boolean>>;
}

export interface FakePushOptions {
  /** `Notification.permission` to start with. */
  permission?: NotificationPermission;
  /** What `requestPermission()` answers. */
  grants?: NotificationPermission;
  /** Start out subscribed, with this application server key (default `VAPID_KEY`). */
  subscribedWith?: string | null;
  /** `navigator.userAgent`. */
  userAgent?: string;
  /** Running as an installed app (`display-mode: standalone`). */
  installed?: boolean;
  /** False leaves out `PushManager` and `Notification`, as Safari does outside an installed app. */
  pushApi?: boolean;
  /** Whether a service worker registration exists (a dev server has none). Default true. */
  registered?: boolean;
}

const bytesOf = (base64url: string): ArrayBuffer => {
  const raw = atob(base64url.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer;
};

/**
 * Makes the test browser look like one with the Push API: `navigator.serviceWorker` with a
 * registration whose `pushManager` keeps one subscription, `PushManager`, `Notification`, and
 * optionally an iPhone user agent or installed-app display mode. Returns the pieces to inspect;
 * call `restore()` after the test.
 */
export function fakePushSupport(options: FakePushOptions = {}): FakePush {
  const state = { subscription: null as FakeSubscription | null, nextId: 1 };

  const makeSubscription = (key: ArrayBuffer | null): FakeSubscription => {
    const id = state.nextId++;
    const subscription: FakeSubscription = {
      endpoint: `https://push.example/send/${id}`,
      options: { applicationServerKey: key },
      toJSON: () => ({
        endpoint: subscription.endpoint,
        keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` },
      }),
      unsubscribe: vi.fn(async () => {
        state.subscription = null;
        return true;
      }),
    };
    return subscription;
  };
  if (options.subscribedWith !== undefined) {
    state.subscription = makeSubscription(
      options.subscribedWith === null ? null : bytesOf(options.subscribedWith),
    );
  }

  const pushManager = {
    getSubscription: vi.fn(async () => state.subscription),
    subscribe: vi.fn(
      async (subscribeOptions: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
        state.subscription = makeSubscription(subscribeOptions.applicationServerKey.slice().buffer);
        return state.subscription;
      },
    ),
  };
  const registration = { pushManager };
  const notification = Object.assign(vi.fn(), {
    permission: options.permission ?? 'default',
    requestPermission: vi.fn(async () => {
      notification.permission = options.grants ?? 'granted';
      return notification.permission;
    }),
  });

  const replaced: PropertyKey[] = [];
  const replace = (name: string, value: unknown) => {
    replaced.push(name);
    Object.defineProperty(navigator, name, { configurable: true, value });
  };
  replace('serviceWorker', {
    getRegistration: vi.fn(async () => (options.registered === false ? undefined : registration)),
    ready: Promise.resolve(registration),
  });
  if (options.userAgent) replace('userAgent', options.userAgent);
  if (options.pushApi !== false) {
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('Notification', notification);
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: options.installed === true && query.includes('standalone'),
    })),
  );

  return {
    registration,
    pushManager,
    notification,
    get subscription() {
      return state.subscription;
    },
    restore() {
      for (const name of replaced) Reflect.deleteProperty(navigator, name);
      vi.unstubAllGlobals();
    },
  };
}
