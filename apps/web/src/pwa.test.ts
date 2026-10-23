import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VAPID_KEY,
  apiError,
  fakePushSupport,
  fakeServer,
  setupApp,
  type FakePush,
} from './test-util.js';
import { FORGET_PUSH_TIMEOUT_MS, forgetPushSubscription } from './pwa.js';

const UNSUBSCRIBE = 'DELETE /api/push/subscriptions';

/** A fresh copy of the module, as it keeps track of whether a worker is on its way. */
async function freshPwa() {
  vi.resetModules();
  return import('./pwa.js');
}

let push: FakePush | undefined;
afterEach(() => {
  push?.restore();
  push = undefined;
  vi.unstubAllEnvs();
});

describe('registerServiceWorker', () => {
  /** A service worker container that records what the page does with it. */
  function container(controller: object | null, existing?: { active: object | null }) {
    const listeners: Record<string, () => void> = {};
    const reload = vi.fn();
    const register = vi.fn<(url: string) => Promise<object>>(async () => ({}));
    vi.stubGlobal('location', { ...window.location, reload });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller,
        register,
        getRegistration: async () => existing,
        addEventListener: (type: string, listener: () => void) => (listeners[type] = listener),
      },
    });
    return { listeners, reload, register };
  }
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
    vi.unstubAllGlobals();
  });

  it('does nothing outside a production build', async () => {
    const { registerServiceWorker } = await freshPwa();
    const { register } = container(null);
    registerServiceWorker();
    expect(register).not.toHaveBeenCalled();
  });

  it('registers /sw.js in production, and needs no update after the first install', async () => {
    const { registerServiceWorker, isUpdatePending } = await freshPwa();
    vi.stubEnv('PROD', true);
    const { listeners, reload, register } = container(null);

    registerServiceWorker();
    expect(register).toHaveBeenCalledWith('/sw.js');

    listeners['controllerchange']?.();
    expect(isUpdatePending()).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    // A deploy while the same tab stays open is an update.
    listeners['controllerchange']?.();
    expect(isUpdatePending()).toBe(true);
  });

  it('treats the first change on a shift-reloaded page, with a worker already active, as an update', async () => {
    const { registerServiceWorker, isUpdatePending } = await freshPwa();
    vi.stubEnv('PROD', true);
    const { listeners } = container(null, { active: {} });

    registerServiceWorker();
    await Promise.resolve();
    await Promise.resolve();
    listeners['controllerchange']?.();

    expect(isUpdatePending()).toBe(true);
  });

  it('only notes an update when a new worker takes over a page the old one controlled', async () => {
    const { registerServiceWorker, isUpdatePending } = await freshPwa();
    vi.stubEnv('PROD', true);
    const { listeners, reload } = container({});

    registerServiceWorker();
    expect(isUpdatePending()).toBe(false);
    listeners['controllerchange']?.();
    listeners['controllerchange']?.();

    expect(isUpdatePending()).toBe(true);
    // The page is left alone: a half-filled form is not thrown away.
    expect(reload).not.toHaveBeenCalled();
  });

  it('ignores a registration that fails', async () => {
    const { registerServiceWorker } = await freshPwa();
    vi.stubEnv('PROD', true);
    const { register } = container(null);
    register.mockRejectedValueOnce(new Error('no'));
    expect(() => registerServiceWorker()).not.toThrow();
    await Promise.resolve();
  });
});

describe('loadPendingUpdate', () => {
  const assign = vi.fn();
  beforeEach(() => {
    assign.mockClear();
    vi.stubGlobal('location', { ...window.location, assign });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does nothing while the page is up to date', async () => {
    const { loadPendingUpdate } = await freshPwa();
    expect(loadPendingUpdate('/tasks')).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it('loads the path as a full page once an update is pending', async () => {
    const { loadPendingUpdate, setUpdatePending, isUpdatePending } = await freshPwa();
    setUpdatePending();
    expect(isUpdatePending()).toBe(true);

    expect(loadPendingUpdate('/tasks?next=/a.b#top')).toBe(true);
    expect(assign).toHaveBeenCalledExactlyOnceWith('/tasks?next=/a.b#top');

    setUpdatePending(false);
    expect(loadPendingUpdate('/tasks')).toBe(false);
  });
});

describe('serviceWorkerRegistration', () => {
  it('is undefined without service worker support', async () => {
    const { serviceWorkerRegistration } = await freshPwa();
    expect(await serviceWorkerRegistration()).toBeUndefined();
  });

  it('is the existing registration when none is being waited for', async () => {
    const { serviceWorkerRegistration } = await freshPwa();
    push = fakePushSupport();
    expect(await serviceWorkerRegistration()).toBe(push.registration);
  });

  it('is undefined when there is no registration', async () => {
    const { serviceWorkerRegistration } = await freshPwa();
    push = fakePushSupport({ registered: false });
    expect(await serviceWorkerRegistration()).toBeUndefined();
  });

  describe('once the worker is being registered', () => {
    afterEach(() => vi.useRealTimers());

    /** A registration that never finds a worker to wait for: `ready` is still pending. */
    async function registering() {
      const pwa = await freshPwa();
      vi.stubEnv('PROD', true);
      push = fakePushSupport({ registered: false });
      const ready = Promise.withResolvers<unknown>();
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          controller: null,
          register: vi.fn(async () => ({})),
          addEventListener: vi.fn(),
          getRegistration: vi.fn(async () => undefined),
          ready: ready.promise,
        },
      });
      pwa.registerServiceWorker();
      return { ...pwa, ready };
    }

    it('waits for the worker to be active', async () => {
      const { serviceWorkerRegistration, ready } = await registering();
      const found = serviceWorkerRegistration();
      ready.resolve(push?.registration);
      expect(await found).toBe(push?.registration);
    });

    it('gives up after ten seconds', async () => {
      const { serviceWorkerRegistration } = await registering();
      vi.useFakeTimers();
      const found = serviceWorkerRegistration();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await found).toBeUndefined();
    });
  });
});

describe('forgetPushSubscription', () => {
  it('deletes this browser`s subscription on the server', async () => {
    push = fakePushSupport({ permission: 'granted', subscribedWith: VAPID_KEY });
    const server = fakeServer({ [UNSUBSCRIBE]: new Response(null, { status: 204 }) });
    setupApp(server);
    const subscription = push.subscription;

    await forgetPushSubscription();

    expect(server.callsTo(UNSUBSCRIBE)[0]?.body).toEqual({ endpoint: subscription?.endpoint });
    // And the browser's own, so the next member to log in is not subscribed without asking.
    expect(subscription?.unsubscribe).toHaveBeenCalledOnce();
    expect(push.subscription).toBeNull();
  });

  it('still unsubscribes the browser when the server cannot be told', async () => {
    push = fakePushSupport({ permission: 'granted', subscribedWith: VAPID_KEY });
    setupApp(fakeServer({ [UNSUBSCRIBE]: apiError(500, 'internal_error', 'Boom') }));
    const subscription = push.subscription;

    await forgetPushSubscription();

    expect(subscription?.unsubscribe).toHaveBeenCalledOnce();
  });

  it('does nothing without a subscription, a registration or service worker support', async () => {
    const server = fakeServer();
    setupApp(server);

    await forgetPushSubscription();
    push = fakePushSupport({ permission: 'granted' });
    await forgetPushSubscription();
    push.restore();
    push = fakePushSupport({ registered: false });
    await forgetPushSubscription();

    expect(server.calls).toEqual([]);
  });

  it('never throws, so logging out cannot be blocked', async () => {
    push = fakePushSupport({ permission: 'granted', subscribedWith: VAPID_KEY });
    setupApp(fakeServer({ [UNSUBSCRIBE]: apiError(500, 'internal_error', 'Boom') }));
    await expect(forgetPushSubscription()).resolves.toBeUndefined();

    push.pushManager.getSubscription.mockRejectedValueOnce(new Error('no'));
    await expect(forgetPushSubscription()).resolves.toBeUndefined();
  });

  describe('when something hangs', () => {
    afterEach(() => vi.useRealTimers());

    it('gives up after the timeout, so logging out is never held up', async () => {
      push = fakePushSupport({ permission: 'granted', subscribedWith: VAPID_KEY });
      setupApp(fakeServer());
      push.pushManager.getSubscription.mockReturnValueOnce(new Promise(() => {}));
      vi.useFakeTimers();
      let done = false;

      const forgetting = forgetPushSubscription().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(FORGET_PUSH_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await forgetting;

      expect(done).toBe(true);
      expect(FORGET_PUSH_TIMEOUT_MS).toBe(3_000);
    });

    it('gives up on a server that never answers', async () => {
      push = fakePushSupport({ permission: 'granted', subscribedWith: VAPID_KEY });
      setupApp(fakeServer({ [UNSUBSCRIBE]: () => new Promise<Response>(() => {}) }));
      vi.useFakeTimers();

      const forgetting = forgetPushSubscription();
      await vi.advanceTimersByTimeAsync(FORGET_PUSH_TIMEOUT_MS);

      await expect(forgetting).resolves.toBeUndefined();
    });

    it('does not leave a timer behind when it finishes in time', async () => {
      push = fakePushSupport({ permission: 'granted', subscribedWith: VAPID_KEY });
      setupApp(fakeServer({ [UNSUBSCRIBE]: new Response(null, { status: 204 }) }));
      vi.useFakeTimers();

      await forgetPushSubscription();

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
