import { describe, expect, it } from 'vitest';
import { isPushServiceEndpoint, pushSubscriptionBodySchema } from './push.js';

describe('isPushServiceEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://android.googleapis.com/gcm/send/abc',
    'https://web.push.apple.com/QGxyz',
    'https://push.apple.com/3/device/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/?token=abc',
    'https://FCM.GoogleAPIs.com/fcm/send/abc',
    // 443 is https's default port, which the URL parser drops.
    'https://fcm.googleapis.com:443/fcm/send/abc',
  ])('accepts %s', (url) => {
    expect(isPushServiceEndpoint(url)).toBe(true);
  });

  it.each([
    ['another host', 'https://push.example/send/1'],
    ['a host that only ends with the same letters', 'https://evilfcm.googleapis.com/x'],
    ['a service name as a subdomain of another host', 'https://fcm.googleapis.com.attacker.com/x'],
    ['a service name with a different top level', 'https://fcm.googleapis.com.evil/x'],
    ['the service name in the path', 'https://attacker.example/fcm.googleapis.com'],
    ['the service name in the query', 'https://attacker.example/?h=push.apple.com'],
    ['a parent domain of a service', 'https://googleapis.com/x'],
    ['a sibling of a service', 'https://storage.googleapis.com/x'],
    ['user info that hides the host', 'https://fcm.googleapis.com@attacker.example/x'],
    ['user info on a real host', 'https://user:pass@fcm.googleapis.com/x'],
    ['a username only', 'https://user@fcm.googleapis.com/x'],
    ['another port', 'https://fcm.googleapis.com:8443/x'],
    ['plain http', 'http://fcm.googleapis.com/x'],
    ['another scheme', 'ftp://fcm.googleapis.com/x'],
    ['an absolute host name with a trailing dot', 'https://fcm.googleapis.com./x'],
    // Hosts Node's legacy `url.parse` (used by web-push to send) cuts short at these characters.
    ['a semicolon in the host', 'https://evil.example;.fcm.googleapis.com/x'],
    ['a quote in the host', "https://evil.example'.fcm.googleapis.com/x"],
    ['a backtick in the host', 'https://evil.example`.fcm.googleapis.com/x'],
    ['a brace in the host', 'https://evil.example{.fcm.googleapis.com/x'],
    ['a backslash after the host', 'https://fcm.googleapis.com\\x'],
    ['an IP address', 'https://127.0.0.1/x'],
    ['not a URL', 'fcm.googleapis.com'],
    ['an empty string', ''],
  ])('refuses %s', (_name, url) => {
    expect(isPushServiceEndpoint(url)).toBe(false);
  });
});

describe('pushSubscriptionBodySchema', () => {
  const keys = { p256dh: 'p', auth: 'a' };

  it('accepts a subscription of a known push service', () => {
    const body = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys };
    expect(pushSubscriptionBodySchema.parse(body)).toEqual(body);
  });

  it('refuses any other endpoint, saying why', () => {
    const result = pushSubscriptionBodySchema.safeParse({
      endpoint: 'https://internal.example/hook',
      keys,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('push service');
  });
});
