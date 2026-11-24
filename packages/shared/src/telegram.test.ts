import { describe, expect, it } from 'vitest';
import { DIGEST_KINDS, REMINDER_KINDS } from './notifications.js';
import {
  TELEGRAM_NOTIFICATION_TYPES,
  telegramNotificationEnabled,
  telegramNotificationsFromDisabled,
  telegramNotificationsPatchSchema,
  telegramNotificationsSchema,
} from './telegram.js';

describe('TELEGRAM_NOTIFICATION_TYPES', () => {
  it('is every reminder kind and every digest kind', () => {
    expect([...TELEGRAM_NOTIFICATION_TYPES]).toEqual([...REMINDER_KINDS, ...DIGEST_KINDS]);
  });
});

describe('telegramNotificationsFromDisabled', () => {
  it('has every type on when nothing is switched off', () => {
    const all = telegramNotificationsFromDisabled([]);
    expect(Object.keys(all)).toEqual([...TELEGRAM_NOTIFICATION_TYPES]);
    expect(Object.values(all).every((on) => on)).toBe(true);
    expect(telegramNotificationsSchema.parse(all)).toEqual(all);
  });

  it('has the listed types off and ignores unknown strings', () => {
    const switches = telegramNotificationsFromDisabled(['nudge', 'morning', 'retired_kind']);
    expect(switches.nudge).toBe(false);
    expect(switches.morning).toBe(false);
    expect(switches.due).toBe(true);
    expect(Object.keys(switches)).not.toContain('retired_kind');
  });
});

describe('telegramNotificationEnabled', () => {
  it('is false only for a type on the off list', () => {
    expect(telegramNotificationEnabled(['due'], 'due')).toBe(false);
    expect(telegramNotificationEnabled(['due'], 'nudge')).toBe(true);
    expect(telegramNotificationEnabled([], 'morning')).toBe(true);
  });
});

describe('telegramNotificationsPatchSchema', () => {
  it('accepts one or more known switches', () => {
    expect(telegramNotificationsPatchSchema.parse({ due: false })).toEqual({ due: false });
    expect(telegramNotificationsPatchSchema.parse({ due: true, morning: false })).toEqual({
      due: true,
      morning: false,
    });
  });

  it.each([{}, { bogus: true }, { due: 'yes' }, { due: null }, { due: false, bogus: true }])(
    'refuses %j',
    (body) => {
      expect(telegramNotificationsPatchSchema.safeParse(body).success).toBe(false);
    },
  );
});
