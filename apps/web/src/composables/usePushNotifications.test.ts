import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent } from 'vue';
import {
  VAPID_KEY,
  apiError,
  fakePushSupport,
  fakeServer,
  json,
  setupApp,
  type FakePush,
  type Handler,
} from '../test-util.js';
import { urlBase64ToBytes, usePushNotifications } from './usePushNotifications.js';

const CONFIG = 'GET /api/push/config';
const SUBSCRIBE = 'POST /api/push/subscriptions';
const UNSUBSCRIBE = 'DELETE /api/push/subscriptions';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

let mounted: VueWrapper | undefined;
let push: FakePush | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  push?.restore();
  push = undefined;
});

const noContent = () => new Response(null, { status: 204 });

/** Mounts the composable against a fake browser and a fake server. */
async function setup(
  browser: Parameters<typeof fakePushSupport>[0] | null = {},
  handlers: Record<string, Handler> = {},
) {
  const server = fakeServer({
    [CONFIG]: json({ publicKey: VAPID_KEY }),
    [SUBSCRIBE]: noContent,
    [UNSUBSCRIBE]: noContent,
    ...handlers,
  });
  setupApp(server);
  if (browser) push = fakePushSupport(browser);
  let api!: ReturnType<typeof usePushNotifications>;
  mounted = mount(
    defineComponent({
      setup() {
        api = usePushNotifications();
        return () => null;
      },
    }),
  );
  await flushPromises();
  return { server, api };
}

describe('urlBase64ToBytes', () => {
  it('decodes URL-safe base64 with or without padding', () => {
    expect(Array.from(urlBase64ToBytes('_-8'))).toEqual([255, 239]);
    expect(Array.from(urlBase64ToBytes('_-8='))).toEqual([255, 239]);
    expect(urlBase64ToBytes(VAPID_KEY)).toHaveLength(65);
  });
});

describe('usePushNotifications state', () => {
  it('is unsupported without the Push API, and does not ask the server', async () => {
    const { api, server } = await setup(null);
    expect(api.state.value).toBe('unsupported');
    expect(server.calls).toEqual([]);
  });

  it('is unsupported when there is no service worker registration (the dev server)', async () => {
    const { api } = await setup({ registered: false });
    expect(api.state.value).toBe('unsupported');
  });

  it('needs the app installed on an iPhone, where Safari hides the Push API until it is', async () => {
    const { api, server } = await setup({ userAgent: IPHONE, pushApi: false });
    expect(api.state.value).toBe('needs-install');
    expect(server.calls).toEqual([]);
  });

  it('treats an iPad that says it is a Mac as an iPad', async () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    try {
      const { api } = await setup({ pushApi: false });
      expect(api.state.value).toBe('needs-install');
    } finally {
      Reflect.deleteProperty(navigator, 'platform');
      Reflect.deleteProperty(navigator, 'maxTouchPoints');
    }
  });

  it('is unsubscribed on an iPhone once the app is installed', async () => {
    const { api } = await setup({ userAgent: IPHONE, installed: true });
    expect(api.state.value).toBe('unsubscribed');
  });

  it('is unconfigured when the server has no VAPID key', async () => {
    const { api } = await setup({}, { [CONFIG]: json({ publicKey: null }) });
    expect(api.state.value).toBe('unconfigured');
  });

  it('is denied when notifications are blocked', async () => {
    const { api } = await setup({ permission: 'denied' });
    expect(api.state.value).toBe('denied');
  });

  it('is unsubscribed when permission is not asked for yet, or granted without a subscription', async () => {
    expect((await setup({ permission: 'default' })).api.state.value).toBe('unsubscribed');
    mounted?.unmount();
    push?.restore();
    expect((await setup({ permission: 'granted' })).api.state.value).toBe('unsubscribed');
  });

  it('is an error, with the api`s message, when the config cannot be fetched', async () => {
    const { api } = await setup(
      {},
      { [CONFIG]: apiError(500, 'internal_error', 'Something went wrong') },
    );
    expect(api.state.value).toBe('error');
    expect(api.failure.value).toBe('Something went wrong');
  });
});

describe('usePushNotifications on load', () => {
  it('saves the subscription again when the browser already has one', async () => {
    const { api, server } = await setup({ permission: 'granted', subscribedWith: VAPID_KEY });

    expect(api.state.value).toBe('subscribed');
    expect(server.callsTo(SUBSCRIBE)).toHaveLength(1);
    expect(server.callsTo(SUBSCRIBE)[0]?.body).toEqual({
      endpoint: push?.subscription?.endpoint,
      keys: { p256dh: 'p256dh-1', auth: 'auth-1' },
    });
    expect(push?.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('replaces a subscription made with another VAPID key, without asking permission again', async () => {
    const oldKey = `${VAPID_KEY.slice(0, -4)}AAAA`;
    const { api, server } = await setup({ permission: 'granted', subscribedWith: oldKey });

    expect(api.state.value).toBe('subscribed');
    expect(push?.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(push?.notification.requestPermission).not.toHaveBeenCalled();
    expect(server.callsTo(SUBSCRIBE)[0]?.body).toMatchObject({
      endpoint: 'https://push.example/send/2',
    });
  });

  it('replaces a subscription that has no key', async () => {
    await setup({ permission: 'granted', subscribedWith: null });
    expect(push?.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('stays subscribed when saving fails, and tries again on the next visit', async () => {
    const { api } = await setup(
      { permission: 'granted', subscribedWith: VAPID_KEY },
      { [SUBSCRIBE]: apiError(500, 'internal_error', 'Something went wrong') },
    );
    expect(api.state.value).toBe('subscribed');
    expect(api.failure.value).toBe('');
    expect(push?.subscription?.unsubscribe).not.toHaveBeenCalled();
  });

  it('does not save anything when the browser has no subscription', async () => {
    const { server } = await setup({ permission: 'granted' });
    expect(server.callsTo(SUBSCRIBE)).toHaveLength(0);
  });
});

describe('usePushNotifications enable', () => {
  it('asks permission, subscribes with the server`s key and saves it', async () => {
    const { api, server } = await setup();

    await api.enable();

    expect(push?.notification.requestPermission).toHaveBeenCalledTimes(1);
    const [subscribeOptions] = push?.pushManager.subscribe.mock.calls[0] ?? [];
    expect(subscribeOptions?.userVisibleOnly).toBe(true);
    expect(Array.from(subscribeOptions?.applicationServerKey ?? [])).toEqual(
      Array.from(urlBase64ToBytes(VAPID_KEY)),
    );
    expect(server.callsTo(SUBSCRIBE)[0]?.body).toEqual({
      endpoint: 'https://push.example/send/1',
      keys: { p256dh: 'p256dh-1', auth: 'auth-1' },
    });
    expect(api.state.value).toBe('subscribed');
    expect(api.busy.value).toBe(false);
    expect(api.failure.value).toBe('');
  });

  it('does not ask again when permission is already granted', async () => {
    const { api } = await setup({ permission: 'granted' });
    await api.enable();
    expect(push?.notification.requestPermission).not.toHaveBeenCalled();
    expect(api.state.value).toBe('subscribed');
  });

  it('becomes denied, and subscribes to nothing, when the person blocks it', async () => {
    const { api, server } = await setup({ grants: 'denied' });
    await api.enable();
    expect(api.state.value).toBe('denied');
    expect(push?.pushManager.subscribe).not.toHaveBeenCalled();
    expect(server.callsTo(SUBSCRIBE)).toHaveLength(0);
  });

  it('stays off when the person dismisses the permission prompt', async () => {
    const { api } = await setup({ grants: 'default' });
    await api.enable();
    expect(api.state.value).toBe('unsubscribed');
    expect(api.failure.value).toBe('');
  });

  it('undoes the browser subscription when the server refuses it', async () => {
    const { api } = await setup(
      {},
      { [SUBSCRIBE]: apiError(409, 'push_not_configured', 'Push is not set up on this server') },
    );
    const created = async () => push?.pushManager.subscribe.mock.results[0]?.value;

    await api.enable();

    expect(api.failure.value).toBe('Push is not set up on this server');
    expect((await created())?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(push?.subscription).toBeNull();
    expect(api.state.value).toBe('unsubscribed');
  });

  it('shows a plain message when the browser cannot subscribe', async () => {
    const { api } = await setup();
    push?.pushManager.subscribe.mockRejectedValueOnce(new DOMException('no', 'AbortError'));

    await api.enable();

    expect(api.failure.value).toBe(
      'Could not set up notifications in this browser. Please try again.',
    );
    expect(api.state.value).toBe('unsubscribed');
  });

  it('refuses an incomplete subscription from the browser', async () => {
    const { api, server } = await setup();
    push?.pushManager.subscribe.mockImplementationOnce(async () => {
      const incomplete = {
        toJSON: () => ({ endpoint: 'https://push.example/send/9' }),
        unsubscribe: async () => true,
      };
      return incomplete as never;
    });

    await api.enable();

    expect(server.callsTo(SUBSCRIBE)).toHaveLength(0);
    expect(api.failure.value).not.toBe('');
  });

  it('ignores a second click while it is busy', async () => {
    const { api } = await setup();
    await Promise.all([api.enable(), api.enable()]);
    expect(push?.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });
});

describe('usePushNotifications disable', () => {
  it('removes the subscription from the server and the browser', async () => {
    const { api, server } = await setup({ permission: 'granted', subscribedWith: VAPID_KEY });
    const subscription = push?.subscription;

    await api.disable();

    expect(server.callsTo(UNSUBSCRIBE)).toHaveLength(1);
    expect(server.callsTo(UNSUBSCRIBE)[0]?.body).toEqual({ endpoint: subscription?.endpoint });
    expect(subscription?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(api.state.value).toBe('unsubscribed');
  });

  it('still turns the browser off when the server cannot be reached', async () => {
    const { api } = await setup(
      { permission: 'granted', subscribedWith: VAPID_KEY },
      { [UNSUBSCRIBE]: apiError(500, 'internal_error', 'Something went wrong') },
    );

    await api.disable();

    expect(push?.subscription).toBeNull();
    expect(api.state.value).toBe('unsubscribed');
    expect(api.failure.value).toBe('');
  });

  it('reports a browser that refuses to unsubscribe', async () => {
    const { api } = await setup({ permission: 'granted', subscribedWith: VAPID_KEY });
    push?.subscription?.unsubscribe.mockRejectedValueOnce(new Error('nope'));

    await api.disable();

    expect(api.failure.value).toContain('Could not set up notifications');
    expect(api.state.value).toBe('subscribed');
  });
});
