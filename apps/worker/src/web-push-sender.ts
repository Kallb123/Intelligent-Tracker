import type { PushSender } from '@tracker/db';
import webpush from 'web-push';
import type { VapidConfig } from './vapid-config.js';

/**
 * A `PushSender` that sends through the `web-push` library, signed with the given VAPID keys.
 * Throws if the keys or subject are not valid VAPID values. A rejected request throws the
 * library's `WebPushError`, whose `statusCode` is how the handler spots a gone subscription.
 */
export function createWebPushSender(config: VapidConfig): PushSender {
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return async (target, message, options) => {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(message),
      { TTL: options.ttlSeconds, urgency: options.urgency },
    );
  };
}
