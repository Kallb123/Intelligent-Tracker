import { describe, expect, it } from 'vitest';
import { readVapidSettings } from './vapid-config.js';

const KEYS = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };

describe('readVapidSettings', () => {
  it('is off, without a warning, when no key is set (the default install)', () => {
    expect(readVapidSettings({})).toEqual({ enabled: false });
    // docker compose passes an unset variable as an empty string.
    expect(
      readVapidSettings({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: ' ', VAPID_SUBJECT: '' }),
    ).toEqual({ enabled: false });
  });

  it('is off with a warning when only one key is set', () => {
    for (const env of [{ VAPID_PUBLIC_KEY: 'pub' }, { VAPID_PRIVATE_KEY: 'priv' }]) {
      expect(readVapidSettings({ ...env, VAPID_SUBJECT: 'mailto:a@example.com' })).toEqual({
        enabled: false,
        warning: expect.stringContaining('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY'),
      });
    }
  });

  it('uses VAPID_SUBJECT when it is a mailto: address or an https: URL', () => {
    for (const subject of ['mailto:admin@example.com', 'https://tracker.example.com/contact']) {
      expect(readVapidSettings({ ...KEYS, VAPID_SUBJECT: ` ${subject} ` })).toEqual({
        enabled: true,
        config: { publicKey: 'pub', privateKey: 'priv', subject },
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
      config: { publicKey: 'pub', privateKey: 'priv', subject: 'https://tracker.example.com' },
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
