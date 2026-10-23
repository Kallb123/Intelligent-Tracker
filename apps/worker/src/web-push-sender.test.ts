import webpush from 'web-push';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebPushSender, PUSH_SEND_TIMEOUT_MS } from './web-push-sender.js';

vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => ({})) },
}));

const config = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:admin@example.com' };

describe('createWebPushSender', () => {
  beforeEach(() => vi.clearAllMocks());

  it('signs with the VAPID keys and sends the message as JSON with its TTL and urgency', async () => {
    const send = createWebPushSender(config);
    const message = { title: 'Tracker', body: 'Bins is due today', tag: 'occurrence:1', url: '/' };

    await send(
      { endpoint: 'https://fcm.googleapis.com/fcm/send/1', p256dh: 'p', auth: 'a' },
      message,
      {
        ttlSeconds: 86_400,
        urgency: 'high',
      },
    );

    expect(webpush.setVapidDetails).toHaveBeenCalledWith('mailto:admin@example.com', 'pub', 'priv');
    expect(webpush.sendNotification).toHaveBeenCalledWith(
      { endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys: { p256dh: 'p', auth: 'a' } },
      JSON.stringify(message),
      { TTL: 86_400, urgency: 'high', timeout: PUSH_SEND_TIMEOUT_MS },
    );
  });

  it('gives a send ten seconds, and a timeout is an ordinary failure (no status) to retry', async () => {
    expect(PUSH_SEND_TIMEOUT_MS).toBe(10_000);
    const timeout = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(timeout);
    const send = createWebPushSender(config);

    const sending = send(
      { endpoint: 'https://fcm.googleapis.com/fcm/send/1', p256dh: 'p', auth: 'a' },
      { title: 't', body: 'b', tag: 'x', url: '/' },
      { ttlSeconds: 1, urgency: 'normal' },
    );

    await expect(sending).rejects.toBe(timeout);
    expect(vi.mocked(webpush.sendNotification).mock.calls[0]?.[2]).toMatchObject({
      timeout: 10_000,
    });
  });

  it('throws when the library rejects the VAPID details', () => {
    vi.mocked(webpush.setVapidDetails).mockImplementationOnce(() => {
      throw new Error('Vapid public key must be a URL safe Base 64 encoded string.');
    });
    expect(() => createWebPushSender(config)).toThrow('Vapid public key');
  });

  it('lets the push service`s error through, with its status', async () => {
    const rejection = Object.assign(new Error('Received unexpected response code'), {
      statusCode: 410,
    });
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(rejection);
    const send = createWebPushSender(config);

    await expect(
      send(
        { endpoint: 'https://fcm.googleapis.com/fcm/send/1', p256dh: 'p', auth: 'a' },
        { title: 't', body: 'b', tag: 'x', url: '/' },
        { ttlSeconds: 1, urgency: 'normal' },
      ),
    ).rejects.toBe(rejection);
  });
});
