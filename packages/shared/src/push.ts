import { z } from 'zod';

/**
 * Web Push (PWA notifications), shared by the api (which stores subscriptions and serves the
 * VAPID public key), the worker (which sends) and the web app (which subscribes and whose service
 * worker shows the notification).
 */

/** `GET /api/push/config`: the VAPID public key, or `null` when the server has push turned off. */
export const pushConfigSchema = z.object({
  /** URL-safe base64, as `PushManager.subscribe({ applicationServerKey })` takes it. */
  publicKey: z.string().nullable(),
});

/**
 * The push services whose endpoints the server accepts: the exact host or any subdomain of one
 * of these (`web.push.apple.com`, `wns2-par02p.notify.windows.com`). They are the services the
 * browsers use (Chrome and Edge on `fcm.googleapis.com`, older Android Chrome on
 * `android.googleapis.com`, Safari, Firefox and Windows). An endpoint is a URL the worker POSTs
 * to, so without this list a member could point the worker at any https host.
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.apple.com',
  'push.services.mozilla.com',
  'notify.windows.com',
];

/**
 * Whether `url` is an endpoint of a known push service (`PUSH_SERVICE_HOSTS`): https, the host
 * is one of them or a `.`-separated subdomain (so `fcm.googleapis.com.attacker.example` and
 * `evilfcm.googleapis.com` are not), no `user:password@` and no port other than the default.
 * Anything that does not parse is refused.
 */
export function isPushServiceEndpoint(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // `port` is empty for the scheme's default, so `:443` is accepted and `:8443` is not.
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    return false;
  }
  // The parser has lower-cased the host, and a trailing dot (an absolute name) does not match.
  const host = parsed.hostname;
  return PUSH_SERVICE_HOSTS.some((service) => host === service || host.endsWith(`.${service}`));
}

/**
 * A browser's push subscription, as `PushSubscription.toJSON()` gives it (the fields the server
 * needs to send to it). `POST /api/push/subscriptions` takes it. The endpoint must be one of the
 * push services in `PUSH_SERVICE_HOSTS`, because the worker sends to it.
 */
export const pushSubscriptionBodySchema = z.object({
  endpoint: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .refine(isPushServiceEndpoint, {
      error: 'The endpoint must belong to a browser push service (https, no port or credentials)',
    }),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
});

/** `DELETE /api/push/subscriptions`: which of the caller's subscriptions to remove. */
export const pushUnsubscribeBodySchema = z.object({
  endpoint: z.url().max(2048),
});

/**
 * What the worker sends in a push message and the service worker shows: the text is rendered on
 * the server (with the household's time zone), so the service worker needs no API call.
 */
export const pushMessageSchema = z.object({
  title: z.string(),
  body: z.string(),
  /** Notifications with the same tag replace each other: one per occurrence. */
  tag: z.string(),
  /** The app path to open when the notification is clicked, e.g. `/`. */
  url: z.string().startsWith('/'),
});

export type PushConfig = z.infer<typeof pushConfigSchema>;
export type PushSubscriptionBody = z.infer<typeof pushSubscriptionBodySchema>;
export type PushUnsubscribeBody = z.infer<typeof pushUnsubscribeBodySchema>;
export type PushMessage = z.infer<typeof pushMessageSchema>;
