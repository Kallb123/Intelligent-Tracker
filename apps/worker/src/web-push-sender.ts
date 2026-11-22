import type { PushSender } from '@tracker/db';
import * as webpush from 'web-push';
import type { VapidConfig } from './vapid-config.js';

/**
 * How long a send's connection may sit idle before it is given up, so a dead connection to a push
 * service does not stall the tick: the outbox holds a row lock while the handler runs. This is
 * web-push's socket idle timeout, not a cap on the whole send: a service that keeps trickling
 * bytes is not cut off. A timeout rejects like any other failed send, so the notification is
 * retried with backoff.
 */
export const PUSH_SEND_TIMEOUT_MS = 10_000;

/**
 * A `PushSender` that sends through the `web-push` library, signed with the given VAPID keys.
 * Throws if the keys or subject are not valid VAPID values. A rejected request throws the
 * library's `WebPushError`, whose `statusCode` is how the handler spots a gone subscription; a send
 * whose connection is idle for `PUSH_SEND_TIMEOUT_MS` throws too (with no status, so it is retried).
 */
export function createWebPushSender(config: VapidConfig): PushSender {
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return async (target, message, options) => {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(message),
      { TTL: options.ttlSeconds, urgency: options.urgency, timeout: PUSH_SEND_TIMEOUT_MS },
    );
  };
}
