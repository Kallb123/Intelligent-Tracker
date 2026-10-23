import webpush from 'web-push';
import { describe, expect, it } from 'vitest';
import { readVapidSettings, vapidKeysMatch } from './vapid-config.js';

// Real key pairs: the settings check that the public key belongs to the private one.
const pair = webpush.generateVAPIDKeys();
const other = webpush.generateVAPIDKeys();
const KEYS = { VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey };

describe('vapidKeysMatch', () => {
  it('is true for the two halves of a generated pair', () => {
    expect(vapidKeysMatch(pair.publicKey, pair.privateKey)).toBe(true);
    expect(vapidKeysMatch(other.publicKey, other.privateKey)).toBe(true);
  });

  it('is false when the public key belongs to another private key', () => {
    expect(vapidKeysMatch(other.publicKey, pair.privateKey)).toBe(false);
    expect(vapidKeysMatch(pair.publicKey, other.privateKey)).toBe(false);
  });

  it('is false for keys that are not P-256 keys, without throwing', () => {
    expect(vapidKeysMatch('pub', 'priv')).toBe(false);
    expect(vapidKeysMatch(pair.publicKey, '')).toBe(false);
    expect(vapidKeysMatch('', pair.privateKey)).toBe(false);
    // The all-zero scalar is not a valid private key.
    expect(vapidKeysMatch(pair.publicKey, Buffer.alloc(32).toString('base64url'))).toBe(false);
  });
});

describe('readVapidSettings', () => {
  it('is off, without a warning, when no key is set (the default install)', () => {
    expect(readVapidSettings({})).toEqual({ enabled: false });
    // docker compose passes an unset variable as an empty string.
    expect(
      readVapidSettings({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: ' ', VAPID_SUBJECT: '' }),
    ).toEqual({ enabled: false });
  });

  it('is off with a warning when only one key is set', () => {
    for (const env of [
      { VAPID_PUBLIC_KEY: pair.publicKey },
      { VAPID_PRIVATE_KEY: pair.privateKey },
    ]) {
      expect(readVapidSettings({ ...env, VAPID_SUBJECT: 'mailto:a@example.com' })).toEqual({
        enabled: false,
        warning: expect.stringContaining('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY'),
      });
    }
  });

  it('is off with a warning when the public key is not the private key`s', () => {
    const env = {
      VAPID_PUBLIC_KEY: other.publicKey,
      VAPID_PRIVATE_KEY: pair.privateKey,
      VAPID_SUBJECT: 'mailto:admin@example.com',
    };
    expect(readVapidSettings(env)).toEqual({
      enabled: false,
      warning: expect.stringContaining('VAPID_PUBLIC_KEY is not the public key of'),
    });
    expect(
      readVapidSettings({ ...env, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' }),
    ).toEqual({ enabled: false, warning: expect.stringContaining('not the public key') });
  });

  it('uses VAPID_SUBJECT when it is a mailto: address or an https: URL', () => {
    for (const subject of ['mailto:admin@example.com', 'https://tracker.example.com/contact']) {
      expect(readVapidSettings({ ...KEYS, VAPID_SUBJECT: ` ${subject} ` })).toEqual({
        enabled: true,
        config: { publicKey: pair.publicKey, privateKey: pair.privateKey, subject },
      });
    }
  });

  it('prefers VAPID_SUBJECT over PUBLIC_BASE_URL', () => {
    const settings = readVapidSettings({
      ...KEYS,
      VAPID_SUBJECT: 'mailto:admin@example.com',
      PUBLIC_BASE_URL: 'https://tracker.example.com',
    });
    expect(settings).toMatchObject({ config: { subject: 'mailto:admin@example.com' } });
  });

  it('is off with a warning when VAPID_SUBJECT is neither, whatever PUBLIC_BASE_URL says', () => {
    for (const subject of ['admin@example.com', 'http://tracker.example.com', 'mailto:']) {
      expect(
        readVapidSettings({
          ...KEYS,
          VAPID_SUBJECT: subject,
          PUBLIC_BASE_URL: 'https://tracker.example.com',
        }),
      ).toEqual({ enabled: false, warning: expect.stringContaining('VAPID_SUBJECT must be') });
    }
  });

  it('falls back to PUBLIC_BASE_URL when that is https', () => {
    expect(
      readVapidSettings({
        ...KEYS,
        VAPID_SUBJECT: '',
        PUBLIC_BASE_URL: 'https://tracker.example.com',
      }),
    ).toEqual({
      enabled: true,
      config: {
        publicKey: pair.publicKey,
        privateKey: pair.privateKey,
        subject: 'https://tracker.example.com',
      },
    });
  });

  it('is off with a warning without a subject when PUBLIC_BASE_URL is not https', () => {
    for (const env of [{}, { PUBLIC_BASE_URL: 'http://localhost:8080' }, { PUBLIC_BASE_URL: '' }]) {
      expect(readVapidSettings({ ...KEYS, ...env })).toEqual({
        enabled: false,
        warning: expect.stringContaining('VAPID_SUBJECT'),
      });
    }
  });
});
