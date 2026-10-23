import { pushMessageSchema } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_MESSAGE,
  NOTIFICATION_BADGE,
  NOTIFICATION_ICON,
  messageFromPushData,
  notificationFor,
  parsePushMessage,
  targetUrlFor,
} from './push-message.js';

const message = {
  title: 'Bins',
  body: 'Put the green bin out tonight',
  tag: 'occurrence-1',
  url: '/tasks',
};
const ORIGIN = 'https://tracker.example';

describe('parsePushMessage', () => {
  it('accepts a message and drops anything extra', () => {
    expect(parsePushMessage(message)).toEqual(message);
    expect(parsePushMessage({ ...message, extra: 1 })).toEqual(message);
  });

  it.each([
    ['null', null],
    ['a string', 'hello'],
    ['an array', [message]],
    ['a missing title', { ...message, title: undefined }],
    ['a numeric body', { ...message, body: 5 }],
    ['a missing tag', { ...message, tag: undefined }],
    ['an empty tag', { ...message, tag: '' }],
    ['a url that is not a path', { ...message, url: 'https://evil.example/' }],
    ['a protocol-relative url', { ...message, url: '//evil.example/' }],
    ['a backslash url', { ...message, url: '/\\evil.example' }],
  ])('refuses %s', (_name, raw) => {
    expect(parsePushMessage(raw)).toBeNull();
  });

  it('agrees with pushMessageSchema, which the worker validates against', () => {
    const samples: unknown[] = [
      message,
      { ...message, url: '/' },
      { ...message, title: '', body: '' },
      { ...message, url: 'tasks' },
      { ...message, tag: 1 },
      { ...message, tag: '' },
      { title: 'x' },
      {},
    ];
    for (const sample of samples) {
      expect(parsePushMessage(sample) !== null, JSON.stringify(sample)).toBe(
        pushMessageSchema.safeParse(sample).success,
      );
    }
  });
});

describe('messageFromPushData', () => {
  it('reads the JSON payload', () => {
    expect(messageFromPushData({ json: () => message })).toEqual(message);
  });

  it.each([
    ['no payload', null],
    ['a payload that is not JSON', { json: () => JSON.parse('not json') }],
    ['JSON that is not a message', { json: () => ({ hello: 'world' }) }],
  ])('shows the generic notification for %s, as a silent push is penalised', (_name, data) => {
    expect(messageFromPushData(data)).toEqual(FALLBACK_MESSAGE);
  });
});

describe('notificationFor', () => {
  it('builds the showNotification arguments, alerting again when a tag is replaced, keeping the url for the click', () => {
    expect(notificationFor(message)).toEqual([
      'Bins',
      {
        body: 'Put the green bin out tonight',
        tag: 'occurrence-1',
        icon: NOTIFICATION_ICON,
        badge: NOTIFICATION_BADGE,
        renotify: true,
        data: { url: '/tasks' },
      },
    ]);
  });
});

describe('targetUrlFor', () => {
  it('resolves the url against the app origin', () => {
    expect(targetUrlFor({ url: '/tasks?x=1' }, ORIGIN)).toBe(`${ORIGIN}/tasks?x=1`);
  });

  it.each([
    ['no data', undefined],
    ['null data', null],
    ['data without a url', {}],
    ['a url that is not a string', { url: 5 }],
    ['another origin', { url: 'https://evil.example/' }],
    ['a protocol-relative url', { url: '//evil.example/' }],
    ['a relative path', { url: 'tasks' }],
  ])('opens the home page for %s', (_name, data) => {
    expect(targetUrlFor(data, ORIGIN)).toBe(`${ORIGIN}/`);
  });
});
