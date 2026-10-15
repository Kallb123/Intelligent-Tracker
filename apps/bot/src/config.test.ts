import { describe, expect, it } from 'vitest';
import { configFromEnv, DEFAULT_DELIVERY_INTERVAL_MS } from './config.js';

describe('configFromEnv', () => {
  it('has no token, database or base URL by default, and polls every ten seconds', () => {
    expect(configFromEnv({})).toEqual({
      token: undefined,
      databaseUrl: undefined,
      deliveryIntervalMs: DEFAULT_DELIVERY_INTERVAL_MS,
      publicBaseUrl: undefined,
      heartbeatFile: undefined,
    });
  });

  it('treats empty and blank values as unset', () => {
    const config = configFromEnv({ TELEGRAM_BOT_TOKEN: '', DATABASE_URL: '  ' });
    expect(config.token).toBeUndefined();
    expect(config.databaseUrl).toBeUndefined();
  });

  it('reads the settings, trimming the base URL of trailing slashes', () => {
    expect(
      configFromEnv({
        TELEGRAM_BOT_TOKEN: ' 123:abc ',
        DATABASE_URL: 'postgres://db/x',
        DELIVERY_INTERVAL_MS: '2500',
        PUBLIC_BASE_URL: 'https://tracker.example/',
        HEARTBEAT_FILE: '/tmp/heartbeat',
      }),
    ).toEqual({
      token: '123:abc',
      databaseUrl: 'postgres://db/x',
      deliveryIntervalMs: 2500,
      publicBaseUrl: 'https://tracker.example',
      heartbeatFile: '/tmp/heartbeat',
    });
  });

  it('falls back to the default for a delivery interval that is not a number', () => {
    expect(configFromEnv({ DELIVERY_INTERVAL_MS: 'soon' }).deliveryIntervalMs).toBe(
      DEFAULT_DELIVERY_INTERVAL_MS,
    );
  });
});
