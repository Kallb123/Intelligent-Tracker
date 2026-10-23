import { describe, expect, it } from 'vitest';
import { configFromEnv } from './config.js';

describe('configFromEnv', () => {
  it('defaults to insecure cookies and no proxy trust', () => {
    expect(configFromEnv({})).toEqual({ auth: { cookieSecure: false }, trustProxy: false });
  });

  it('derives Secure cookies from an https PUBLIC_BASE_URL and trims the trailing slash', () => {
    expect(configFromEnv({ PUBLIC_BASE_URL: 'https://tracker.example/' }).auth).toEqual({
      publicBaseUrl: 'https://tracker.example',
      cookieSecure: true,
    });
    expect(configFromEnv({ PUBLIC_BASE_URL: 'http://localhost:8080' }).auth).toEqual({
      publicBaseUrl: 'http://localhost:8080',
      cookieSecure: false,
    });
  });

  it('lets COOKIE_SECURE override the guess, and reads TRUST_PROXY', () => {
    const env = { PUBLIC_BASE_URL: 'https://tracker.example', COOKIE_SECURE: 'false' };
    expect(configFromEnv(env).auth.cookieSecure).toBe(false);
    expect(configFromEnv({ COOKIE_SECURE: 'TRUE' }).auth.cookieSecure).toBe(true);
    expect(configFromEnv({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(configFromEnv({ TRUST_PROXY: 'no' }).trustProxy).toBe(false);
  });

  it('reads TELEGRAM_BOT_USERNAME without a leading @, and ignores an empty one', () => {
    expect(configFromEnv({ TELEGRAM_BOT_USERNAME: ' @tracker_bot ' }).auth).toEqual({
      cookieSecure: false,
      telegramBotUsername: 'tracker_bot',
    });
    expect(configFromEnv({ TELEGRAM_BOT_USERNAME: '@' }).auth).toEqual({ cookieSecure: false });
  });

  it('reads VAPID_PUBLIC_KEY, and ignores an empty one', () => {
    expect(configFromEnv({ VAPID_PUBLIC_KEY: ' BKey_-123 ' }).auth).toEqual({
      cookieSecure: false,
      vapidPublicKey: 'BKey_-123',
    });
    expect(configFromEnv({ VAPID_PUBLIC_KEY: ' ' }).auth).toEqual({ cookieSecure: false });
  });

  it('ignores an empty PUBLIC_BASE_URL', () => {
    expect(configFromEnv({ PUBLIC_BASE_URL: '  ' }).auth).toEqual({ cookieSecure: false });
  });
});
