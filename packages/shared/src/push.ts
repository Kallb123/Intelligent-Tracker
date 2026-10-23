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
 * A browser's push subscription, as `PushSubscription.toJSON()` gives it (the fields the server
 * needs to send to it). `POST /api/push/subscriptions` takes it.
 */
export const pushSubscriptionBodySchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
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
