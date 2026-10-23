/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { isAppPagePath } from './app-routes.js';
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

// A new version takes over straight away, instead of waiting for every tab to close. An open page
// notices (src/pwa.ts) and loads the new version at its next navigation.
void self.skipWaiting();
clientsClaim();

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Page loads (not `/api`, `/ical` or a file) get the app shell. This is a plain matcher rather
// than workbox's `NavigationRoute` denylist, which tests the path plus the query string.
registerRoute(
  ({ request, url }) => request.mode === 'navigate' && isAppPagePath(url.pathname),
  createHandlerBoundToURL('/index.html'),
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
