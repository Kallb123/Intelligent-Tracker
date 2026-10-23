import type { ReminderPayload } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { isPushGone, PUSH_APP_TITLE, PUSH_TTL_SECONDS, renderPushMessage } from './web-push.js';

const payload = (overrides: Partial<ReminderPayload> = {}): ReminderPayload => ({
  type: 'reminder',
  kind: 'due',
  taskId: '00000000-0000-4000-8000-000000000001',
  occurrenceId: '00000000-0000-4000-8000-000000000002',
  taskTitle: 'Bins',
  dueDate: '2026-07-10',
  dueAt: null,
  fireAt: '2026-07-10T07:00:00.000Z',
  assigneeId: null,
  ...overrides,
});

describe('isPushGone', () => {
  it('is true for the push service`s 404 and 410 only', () => {
    expect(isPushGone(Object.assign(new Error('gone'), { statusCode: 410 }))).toBe(true);
    expect(isPushGone(Object.assign(new Error('not found'), { statusCode: 404 }))).toBe(true);
    expect(isPushGone(Object.assign(new Error('busy'), { statusCode: 503 }))).toBe(false);
    expect(isPushGone(Object.assign(new Error('bad'), { statusCode: 400 }))).toBe(false);
  });

  it('is false for errors without a status', () => {
    expect(isPushGone(new Error('ECONNRESET'))).toBe(false);
    expect(isPushGone('410')).toBe(false);
    expect(isPushGone(null)).toBe(false);
    expect(isPushGone(undefined)).toBe(false);
  });
});

describe('renderPushMessage', () => {
  it('says what the bell and Telegram say, tagged by occurrence, opening Today', () => {
    expect(renderPushMessage(payload(), 'Europe/London')).toEqual({
      title: PUSH_APP_TITLE,
      body: 'Bins is due today',
      tag: 'occurrence:00000000-0000-4000-8000-000000000002',
      url: '/',
    });
  });

  it('writes a timed due in the household`s zone', () => {
    const timed = payload({ dueDate: null, dueAt: '2026-07-10T17:30:00.000Z' });
    expect(renderPushMessage(timed, 'Europe/London').body).toBe('Bins is due today at 18:30');
    expect(renderPushMessage(timed, 'America/New_York').body).toBe('Bins is due today at 13:30');
  });
});

describe('PUSH_TTL_SECONDS', () => {
  it('is how long the outbox still delivers a late reminder, in seconds', () => {
    expect(PUSH_TTL_SECONDS).toBe(24 * 60 * 60);
  });
});
