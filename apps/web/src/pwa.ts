import { getApi } from './api/index.js';

/** How long to wait for a service worker that was expected before deciding there is none. */
const ACTIVATION_TIMEOUT_MS = 10_000;

/** True once the service worker has been registered by this page, so it is on its way. */
let expected = false;

/**
 * Registers the service worker (`/sw.js`, built from src/sw/sw.ts), in production builds only: a
 * precaching worker would serve stale files over the dev server. A new version takes over
 * straight away (the worker calls `skipWaiting` and `clients.claim`), and an app that was already
 * under the old worker reloads then, as its code and lazily loaded chunks belong to the old
 * version. The very first install also claims the page but does not reload it.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  expected = true;
  const container = navigator.serviceWorker;
  const hadWorker = container.controller !== null;
  let reloading = false;
  container.addEventListener('controllerchange', () => {
    if (!hadWorker || reloading) return;
    reloading = true;
    window.location.reload();
  });
  // A failure only means no offline shell and no push: the app itself is unaffected.
  container.register('/sw.js').catch(() => undefined);
}

/**
 * This page's service worker registration, or undefined when there is none and none is coming
 * (development, or a browser without service workers) or it did not become active in time. A
 * worker that is on its way is awaited, because push subscriptions need it to be active.
 */
export async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  if (!expected) return navigator.serviceWorker.getRegistration();
  let timer: number | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = window.setTimeout(resolve, ACTIVATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turns push off for this browser on logout: deletes the subscription on the server, so the next
 * person to log in on a shared device does not get the previous member's reminders, then
 * unsubscribes the browser too, so the Account page does not silently save it for whoever logs in
 * next (they turn it on themselves). Best effort, and it never waits for a service worker: there
 * is nothing to do when push is not in use here, and a failure is ignored so logging out is never
 * blocked. The browser is unsubscribed even when the server could not be told; the worker drops
 * a subscription once the push service reports it gone.
 */
export async function forgetPushSubscription(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await getApi()
      .DELETE('/api/push/subscriptions', { body: { endpoint: subscription.endpoint } })
      .catch(() => undefined);
    await subscription.unsubscribe();
  } catch {
    // Never block logging out.
  }
}
