import { getApi } from './api/index.js';

/** How long to wait for a service worker that was expected before deciding there is none. */
const ACTIVATION_TIMEOUT_MS = 10_000;

/** True once the service worker has been registered by this page, so it is on its way. */
let expected = false;

/** Set when a new version has taken over from the one this page was loaded with. */
let updatePending = false;

/** Whether a newer version of the app is active than the one this page is running. */
export function isUpdatePending(): boolean {
  return updatePending;
}

/** Records (or, for tests, clears) that a newer version of the app is active. */
export function setUpdatePending(pending = true): void {
  updatePending = pending;
}

/**
 * If a new version of the app is waiting, loads `path` from the server as a full page load
 * instead of a client-side navigation, and returns true (the caller then cancels its own
 * navigation). The new page runs the new code and fetches the new lazily loaded chunks. Returns
 * false, doing nothing, when the page is up to date.
 */
export function loadPendingUpdate(path: string): boolean {
  if (!updatePending) return false;
  window.location.assign(path);
  return true;
}

/**
 * Registers the service worker (`/sw.js`, built from src/sw/sw.ts), in production builds only: a
 * precaching worker would serve stale files over the dev server. A new version takes over
 * straight away (the worker calls `skipWaiting` and `clients.claim`). A page that was already
 * under the old worker keeps running its old code, whose lazily loaded chunks no longer exist, so
 * it only notes that an update is pending: the router then loads the new version at the next
 * navigation (`loadPendingUpdate`), rather than reloading under the member and losing a
 * half-filled form. The very first install also claims the page, which needs no update; a later
 * deploy while that page stays open does.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  expected = true;
  const container = navigator.serviceWorker;
  // A page loaded without a worker is claimed by the first one to install: that first change
  // needs no update, but any later one (a deploy while the tab stays open) does. A page that is
  // uncontrolled although a worker is already active (a shift-reload bypasses it) is not a first
  // install: the next change it sees is a deploy.
  let claimedOnInstall = container.controller === null;
  if (claimedOnInstall) {
    container
      .getRegistration()
      .then((registration) => {
        if (registration?.active) claimedOnInstall = false;
      })
      .catch(() => undefined);
  }
  container.addEventListener('controllerchange', () => {
    if (claimedOnInstall) claimedOnInstall = false;
    else updatePending = true;
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

/** How long logging out waits for `forgetPushSubscription` before carrying on without it. */
export const FORGET_PUSH_TIMEOUT_MS = 3_000;

/** Deletes this browser's push subscription on the server, then unsubscribes the browser. */
async function unsubscribeThisBrowser(): Promise<void> {
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
    // Ignored: see `forgetPushSubscription`.
  }
}

/**
 * Turns push off for this browser on logout: deletes the subscription on the server, so the next
 * person to log in on a shared device does not get the previous member's reminders, then
 * unsubscribes the browser too, so the Account page does not silently save it for whoever logs in
 * next (they turn it on themselves). Best effort, and it never waits for a service worker: there
 * is nothing to do when push is not in use here, and a failure is ignored so logging out is never
 * blocked. It also gives up after `FORGET_PUSH_TIMEOUT_MS`, so a hung API or service worker
 * lookup cannot hang logout; what was not finished by then is left to the worker, which drops a
 * subscription once the push service reports it gone. The browser is unsubscribed even when the
 * server could not be told.
 */
export async function forgetPushSubscription(): Promise<void> {
  let timer: number | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = window.setTimeout(resolve, FORGET_PUSH_TIMEOUT_MS);
  });
  try {
    await Promise.race([unsubscribeThisBrowser(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
