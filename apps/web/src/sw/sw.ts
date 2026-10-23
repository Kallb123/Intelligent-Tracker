/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { messageFromPushData, notificationFor, targetUrlFor } from './push-message.js';

/**
 * The app's service worker, built by vite-plugin-pwa (`injectManifest`, see vite.config.ts) into
 * `/sw.js`. It does two jobs:
 *
 * 1. Offline app shell: the built files are precached, and page loads are answered with the cached
 *    `index.html` (the router takes it from there), so the installed app opens without a network.
 *    It never touches `/api/*` or `/ical/*`, nor requests for files such as `/manifest.webmanifest`,
 *    so data is always live and the calendar feed is never replaced by the app.
 * 2. Web Push: shows the notification a push message describes and, when it is clicked, brings
 *    the app to the front at the message's URL.
 */
declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (PrecacheEntry | string)[] };

// A new version takes over straight away (with `registerType: 'autoUpdate'` the open pages then
// reload), instead of waiting for every tab to close.
void self.skipWaiting();
clientsClaim();

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    // `/api` and `/ical` are the backend; a path ending in `.ext` is a file, not a page.
    denylist: [/^\/api(\/|$)/, /^\/ical(\/|$)/, /\/[^/?]+\.[^/]+$/],
  }),
);

self.addEventListener('push', (event) => {
  const [title, options] = notificationFor(messageFromPushData(event.data));
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openApp(targetUrlFor(event.notification.data, self.location.origin)));
});

/** Brings an open app window to the front at `url`, or opens one. */
async function openApp(url: string): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // Most recently focused first.
  const existing = windows[0];
  if (existing) {
    try {
      const focused = await existing.focus();
      // Already there (for example the same path with a different hash): leave the page alone.
      if (focused.url !== url) await focused.navigate(url);
      return;
    } catch {
      // A window this worker does not control cannot be navigated: open a new one instead.
    }
  }
  await self.clients.openWindow(url);
}
