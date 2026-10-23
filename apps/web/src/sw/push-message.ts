import type { PushMessage } from '@tracker/shared';

/**
 * The pure parts of the service worker's push handling, kept apart from `sw.ts` (which needs a
 * service worker to run) so they can be unit tested. `PushMessage` is imported as a type only, so
 * the service worker bundle stays small: it does not use zod's `pushMessageSchema`, and
 * `parsePushMessage` below is a hand-written check that `push-message.test.ts` compares with it.
 */

/**
 * Shown when a push arrives without a readable message. Browsers penalise (and may revoke
 * permission for) a push that shows nothing, so something is always displayed.
 */
export const FALLBACK_MESSAGE: PushMessage = {
  title: 'Intelligent Tracker',
  body: 'You have a reminder. Open the app to see it.',
  tag: 'tracker-reminder',
  url: '/',
};

/** The icon and badge files in `public/`. The badge is white on transparent, as Android needs. */
export const NOTIFICATION_ICON = '/icon-192.png';
export const NOTIFICATION_BADGE = '/badge-96.png';

/** A path inside this app: one slash then anything but another slash or backslash. */
const isAppPath = (value: string): boolean => /^\/(?![/\\])/.test(value);

/**
 * Checks a decoded push payload is a message: strings for the four fields (a non-empty `tag`,
 * which `renotify` needs, or showing it would fail and the push would be silent), and a `url` that is a
 * path in this app. A `url` such as `//evil.example` (which a browser reads as another site) is
 * refused. Returns null for anything else.
 */
export function parsePushMessage(raw: unknown): PushMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { title, body, tag, url } = raw as Record<string, unknown>;
  if (
    typeof title !== 'string' ||
    typeof body !== 'string' ||
    typeof tag !== 'string' ||
    tag === '' ||
    typeof url !== 'string' ||
    !isAppPath(url)
  ) {
    return null;
  }
  return { title, body, tag, url };
}

/**
 * The message in a push event's data, or `FALLBACK_MESSAGE` when there is none or it is not
 * JSON or not a message (`event.data` is null for a push without a payload).
 */
export function messageFromPushData(data: { json(): unknown } | null): PushMessage {
  try {
    return (data && parsePushMessage(data.json())) ?? FALLBACK_MESSAGE;
  } catch {
    return FALLBACK_MESSAGE;
  }
}

/** `NotificationOptions` with `renotify`, which browsers support but the WebWorker lib omits. */
export type PushNotificationOptions = NotificationOptions & { renotify: boolean };

/** The arguments for `registration.showNotification`. */
export function notificationFor(message: PushMessage): [string, PushNotificationOptions] {
  return [
    message.title,
    {
      body: message.body,
      tag: message.tag,
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_BADGE,
      // There is one tag per occurrence, so a later push for the same occurrence (the due
      // reminder after a heads-up) replaces the earlier notification; without `renotify` the
      // replacement would be silent, and the later one is the one that must alert.
      renotify: true,
      data: { url: message.url },
    },
  ];
}

/**
 * The absolute URL to open for a clicked notification: its `data.url` resolved against the app's
 * origin. Anything missing, unreadable or pointing at another origin opens the home page.
 */
export function targetUrlFor(data: unknown, origin: string): string {
  const fallback = new URL('/', origin).href;
  const url = (data as { url?: unknown } | null | undefined)?.url;
  if (typeof url !== 'string' || !isAppPath(url)) return fallback;
  const target = new URL(url, origin);
  return target.origin === new URL(origin).origin ? target.href : fallback;
}
