import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenForInstallPrompt } from '../composables/useInstallPrompt.js';
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
import PushNotificationsPanel from './PushNotificationsPanel.vue';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

let wrapper: VueWrapper | undefined;
let push: FakePush | undefined;
let stopListening: (() => void) | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  push?.restore();
  push = undefined;
  stopListening?.();
  stopListening = undefined;
  document.body.replaceChildren();
});

async function panel(
  browser: Parameters<typeof fakePushSupport>[0] | null,
  handlers: Record<string, Handler> = {},
) {
  const server = fakeServer({
    'GET /api/push/config': json({ publicKey: VAPID_KEY }),
    'POST /api/push/subscriptions': new Response(null, { status: 204 }),
    'DELETE /api/push/subscriptions': new Response(null, { status: 204 }),
    ...handlers,
  });
  setupApp(server);
  if (browser) push = fakePushSupport(browser);
  wrapper = mount(PushNotificationsPanel, {
    global: { plugins: [PrimeVue] },
    attachTo: document.body,
  });
  await flushPromises();
  return { server, wrapper };
}

const section = () => (wrapper as VueWrapper).get('[aria-labelledby="push-heading"]');
const button = (label: string) =>
  (wrapper as VueWrapper).findAll('button').find((b) => b.text() === label);

describe('PushNotificationsPanel', () => {
  it('offers to turn notifications on, then shows them on', async () => {
    await panel({});
    expect(section().text()).toContain('Off');
    expect(button('Turn off notifications')).toBeUndefined();

    await button('Turn on notifications')?.trigger('click');
    await flushPromises();

    expect(section().text()).toContain('On');
    expect(button('Turn on notifications')).toBeUndefined();
    expect(push?.subscription).not.toBeNull();
  });

  it('turns them off again', async () => {
    const { server } = await panel({ permission: 'granted', subscribedWith: VAPID_KEY });
    expect(section().text()).toContain('On');

    await button('Turn off notifications')?.trigger('click');
    await flushPromises();

    expect(server.callsTo('DELETE /api/push/subscriptions')).toHaveLength(1);
    expect(section().text()).toContain('Off');
    expect(push?.subscription).toBeNull();
  });

  it('says why when the api refuses, outside the panel as an alert', async () => {
    await panel(
      {},
      {
        'POST /api/push/subscriptions': apiError(
          409,
          'push_not_configured',
          'Push notifications are not set up on this server',
        ),
      },
    );

    await button('Turn on notifications')?.trigger('click');
    await flushPromises();

    expect((wrapper as VueWrapper).get('[role="alert"]').text()).toBe(
      'Push notifications are not set up on this server',
    );
    expect(button('Turn on notifications')).toBeDefined();
  });

  it.each([
    ['this browser cannot show notifications', null, {}],
    ['not been set up on this server', {}, { 'GET /api/push/config': json({ publicKey: null }) }],
    ['blocked for this site', { permission: 'denied' as const }, {}],
    ['could not check', {}, { 'GET /api/push/config': apiError(500, 'internal_error', 'Boom') }],
  ])('explains when %s, with nothing to press', async (words, browser, handlers) => {
    await panel(browser, handlers);
    expect(section().text().toLowerCase()).toContain(words);
    expect(section().find('button').exists()).toBe(false);
  });

  it('tells iPhone users to add the app to the Home Screen first', async () => {
    const { server } = await panel({ userAgent: IPHONE, pushApi: false });
    expect(section().text()).toContain('Add to Home Screen');
    expect(section().find('button').exists()).toBe(false);
    expect(server.calls).toEqual([]);
  });

  it('offers to install the app once the browser says it can be', async () => {
    stopListening = listenForInstallPrompt();
    await panel({});
    expect(button('Install app')).toBeUndefined();

    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: vi.fn(async () => undefined),
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    window.dispatchEvent(event);
    await flushPromises();
    await button('Install app')?.trigger('click');
    await flushPromises();

    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(button('Install app')).toBeUndefined();
  });

  it('offers install even where notifications cannot work', async () => {
    stopListening = listenForInstallPrompt();
    await panel(null);
    window.dispatchEvent(
      Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
        prompt: async () => undefined,
        userChoice: Promise.resolve({ outcome: 'dismissed' as const }),
      }),
    );
    await flushPromises();
    expect(button('Install app')).toBeDefined();
  });
});
