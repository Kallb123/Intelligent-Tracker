import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VAPID_KEY,
  apiError,
  fakePushSupport,
  fakeServer,
  setupApp,
  type FakePush,
} from './test-util.js';
import { forgetPushSubscription } from './pwa.js';

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
  function container(controller: object | null) {
    const listeners: Record<string, () => void> = {};
    const reload = vi.fn();
    const register = vi.fn<(url: string) => Promise<object>>(async () => ({}));
    vi.stubGlobal('location', { ...window.location, reload });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller,
        register,
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

  it('registers /sw.js in production, and does not reload after the first install', async () => {
    const { registerServiceWorker } = await freshPwa();
    vi.stubEnv('PROD', true);
    const { listeners, reload, register } = container(null);

    registerServiceWorker();
    expect(register).toHaveBeenCalledWith('/sw.js');

    listeners['controllerchange']?.();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads once when a new worker takes over a page the old one controlled', async () => {
    const { registerServiceWorker } = await freshPwa();
    vi.stubEnv('PROD', true);
    const { listeners, reload } = container({});

    registerServiceWorker();
    listeners['controllerchange']?.();
    listeners['controllerchange']?.();

    expect(reload).toHaveBeenCalledTimes(1);
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
});
