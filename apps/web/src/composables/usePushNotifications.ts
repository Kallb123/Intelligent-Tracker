import { pushSubscriptionBodySchema } from '@tracker/shared';
import { onMounted, ref } from 'vue';
import { ApiError, describeError, getApi } from '../api/index.js';
import { serviceWorkerRegistration } from '../pwa.js';

/**
 * Where this browser stands with Web Push:
 * - `loading`: still finding out
 * - `unsupported`: no service worker, Push API or Notification API here (or this is a build
 *   without the service worker, such as the dev server)
 * - `needs-install`: iPhone/iPad Safari, which only offers Web Push to an app added to the Home Screen
 * - `unconfigured`: the server has no VAPID keys, so it cannot send
 * - `denied`: the person blocked notifications for this site in the browser
 * - `subscribed` / `unsubscribed`: on or off for this browser (this member, on the server)
 * - `error`: the server or the browser failed while finding out; `failure` says how
 */
export type PushState =
  | 'loading'
  | 'unsupported'
  | 'needs-install'
  | 'unconfigured'
  | 'denied'
  | 'subscribed'
  | 'unsubscribed'
  | 'error';

/** URL-safe base64 (the VAPID public key) to the bytes `applicationServerKey` takes. */
export function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4))
    .replaceAll('-', '+')
    .replaceAll('_', '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Whether a subscription was made with this application server key (the VAPID public key). */
function usesKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((byte, i) => byte === key[i]);
}

/** iPhone, iPad (which says it is a Mac, but has a touch screen) and iPod. */
function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/** Running as an installed app (from the Home Screen or the app launcher), not in a browser tab. */
function isInstalled(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

const failureText = (err: unknown): string =>
  err instanceof ApiError
    ? describeError(err)
    : 'Could not set up notifications in this browser. Please try again.';

/**
 * Turning push notifications on and off for this browser. It works out
 * the browser's `state`, then `enable()` asks permission, subscribes to the push service with
 * the server's VAPID key and saves the subscription for the logged-in member; `disable()` removes
 * it from the server and the browser.
 *
 * When the browser is already subscribed, the subscription is saved again on load, so the server
 * stays in step with the browser: after another member used this device, or when the push service
 * rotated the keys. A subscription made with an old VAPID key is replaced (the permission is
 * already granted, so there is no prompt).
 */
export function usePushNotifications() {
  const state = ref<PushState>('loading');
  /** True while `enable()` or `disable()` runs. */
  const busy = ref(false);
  /** The last error, in words; cleared when something is tried again. */
  const failure = ref('');

  let registration: ServiceWorkerRegistration | undefined;
  let publicKey = '';

  const supported = (): boolean =>
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const subscribe = (): Promise<PushSubscription> =>
    (registration as ServiceWorkerRegistration).pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(publicKey),
    });

  /** Saves a subscription for the logged-in member (a repeat refreshes it). */
  async function save(subscription: PushSubscription): Promise<void> {
    const body = pushSubscriptionBodySchema.safeParse(subscription.toJSON());
    if (!body.success) throw new Error('The browser gave an incomplete push subscription');
    await getApi().POST('/api/push/subscriptions', { body: body.data });
  }

  /**
   * Makes sure the browser has a subscription for the current key and the server has it. One this
   * call made is undone again if the server refuses it, so the two never disagree.
   */
  async function ensureSubscribed(): Promise<void> {
    const pushManager = (registration as ServiceWorkerRegistration).pushManager;
    let current = await pushManager.getSubscription();
    if (current && !usesKey(current, urlBase64ToBytes(publicKey))) {
      await current.unsubscribe();
      current = null;
    }
    const created = current ? null : await subscribe();
    try {
      await save((current ?? created) as PushSubscription);
    } catch (err) {
      await created?.unsubscribe().catch(() => false);
      throw err;
    }
  }

  /** Reads `denied` / `subscribed` / `unsubscribed` from the browser and sets the state to it. */
  async function settle(): Promise<PushState> {
    if (Notification.permission === 'denied') return (state.value = 'denied');
    const subscription = await registration?.pushManager.getSubscription();
    const on = subscription && Notification.permission === 'granted';
    return (state.value = on ? 'subscribed' : 'unsubscribed');
  }

  async function load(): Promise<void> {
    failure.value = '';
    state.value = 'loading';
    // Safari on iOS hides the Push API until the app is installed, so this must come first.
    if (isIos() && !isInstalled()) {
      state.value = 'needs-install';
      return;
    }
    if (!supported()) {
      state.value = 'unsupported';
      return;
    }
    try {
      const { data } = await getApi().GET('/api/push/config');
      if (!data?.publicKey) {
        state.value = 'unconfigured';
        return;
      }
      publicKey = data.publicKey;
      registration = await serviceWorkerRegistration();
      if (!registration) {
        state.value = 'unsupported';
        return;
      }
      if ((await settle()) === 'subscribed') {
        // Best effort: the next visit tries again.
        await ensureSubscribed().catch(() => undefined);
        await settle();
      }
    } catch (err) {
      failure.value = failureText(err);
      state.value = 'error';
    }
  }

  /** Asks permission if needed, subscribes and saves. */
  async function enable(): Promise<void> {
    if (busy.value || !registration) return;
    busy.value = true;
    failure.value = '';
    try {
      if (Notification.permission !== 'granted') {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;
      }
      await ensureSubscribed();
    } catch (err) {
      failure.value = failureText(err);
    } finally {
      await settle().catch(() => undefined);
      busy.value = false;
    }
  }

  /** Removes the subscription from the server and the browser. */
  async function disable(): Promise<void> {
    if (busy.value || !registration) return;
    busy.value = true;
    failure.value = '';
    try {
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        // If the server cannot be reached the browser still stops: the server drops the dead
        // subscription the first time a push to it is refused.
        await getApi()
          .DELETE('/api/push/subscriptions', { body: { endpoint: subscription.endpoint } })
          .catch(() => undefined);
        await subscription.unsubscribe();
      }
    } catch (err) {
      failure.value = failureText(err);
    } finally {
      await settle().catch(() => undefined);
      busy.value = false;
    }
  }

  onMounted(load);

  return { state, busy, failure, enable, disable, reload: load };
}
