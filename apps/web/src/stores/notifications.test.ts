import type { NotificationDto } from '@tracker/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, fakeServer, json, setupApp, type Handler } from '../test-util.js';
import { NOTIFICATION_POLL_MS, useNotificationsStore } from './notifications.js';

const LIST = 'GET /api/notifications';
const READ_ALL = 'POST /api/notifications/read-all';
const readOne = (id: string) => `POST /api/notifications/${id}/read`;

const notification = (id: string, readAt: string | null = null): NotificationDto => ({
  id,
  createdAt: '2026-10-13T08:00:00.000Z',
  readAt,
  payload: {
    type: 'reminder',
    kind: 'due',
    taskId: '33333333-3333-4333-8333-333333333333',
    occurrenceId: '44444444-4444-4444-8444-444444444444',
    taskTitle: `Task ${id}`,
    dueDate: '2026-10-13',
    dueAt: null,
    fireAt: '2026-10-13T08:00:00.000Z',
    assigneeId: null,
  },
});

const list = (items: NotificationDto[]): Handler =>
  json({ items, unreadCount: items.filter((n) => n.readAt === null).length });

function store(handlers: Record<string, Handler>) {
  const server = fakeServer(handlers);
  setupApp(server);
  return { server, notifications: useNotificationsStore() };
}

describe('notifications store', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('loads the items and the unread count', async () => {
    const { notifications: n } = store({
      [LIST]: list([notification('a'), notification('b', 'x')]),
    });

    await n.load();

    expect(n.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(n.unreadCount).toBe(1);
    expect(n.error).toBe('');
  });

  it('keeps what it has and reports the error when a load fails', async () => {
    let fail = false;
    const { notifications: n } = store({
      [LIST]: () =>
        fail
          ? apiError(500, 'internal_error', 'Something went wrong')
          : json({ items: [notification('a')], unreadCount: 1 }),
    });
    await n.load();

    fail = true;
    await n.load();

    expect(n.items).toHaveLength(1);
    expect(n.error).toBe('Something went wrong');
  });

  it('marks one read on screen and tells the api', async () => {
    const { server, notifications: n } = store({
      [LIST]: list([notification('a'), notification('b')]),
      [readOne('a')]: new Response(null, { status: 204 }),
    });
    await n.load();

    await n.markRead('a');

    expect(n.items.map((i) => i.readAt !== null)).toEqual([true, false]);
    expect(n.unreadCount).toBe(1);
    expect(server.callsTo(readOne('a'))).toHaveLength(1);
    expect(server.callsTo(readOne('a'))[0]?.headers.get('x-csrf-token')).toBeDefined();
  });

  it('does not count an already-read notification twice', async () => {
    const { notifications: n } = store({
      [LIST]: list([notification('a', '2026-10-13T09:00:00.000Z'), notification('b')]),
      [readOne('a')]: new Response(null, { status: 204 }),
    });
    await n.load();

    await n.markRead('a');

    expect(n.unreadCount).toBe(1);
  });

  it('reloads when marking one read fails', async () => {
    const { server, notifications: n } = store({
      [LIST]: list([notification('a')]),
      [readOne('a')]: apiError(404, 'not_found', 'No such notification'),
    });
    await n.load();

    await n.markRead('a');

    expect(server.callsTo(LIST)).toHaveLength(2);
    expect(n.unreadCount).toBe(1);
  });

  it('marks everything read', async () => {
    const { server, notifications: n } = store({
      [LIST]: list([notification('a'), notification('b')]),
      [READ_ALL]: new Response(null, { status: 204 }),
    });
    await n.load();

    await n.markAllRead();

    expect(n.items.every((i) => i.readAt !== null)).toBe(true);
    expect(n.unreadCount).toBe(0);
    expect(server.callsTo(READ_ALL)).toHaveLength(1);
  });

  it('reloads when marking all read fails', async () => {
    const { server, notifications: n } = store({
      [LIST]: list([notification('a')]),
      [READ_ALL]: apiError(500, 'internal_error', 'Something went wrong'),
    });
    await n.load();

    await n.markAllRead();

    expect(n.unreadCount).toBe(1);
    expect(server.callsTo(LIST)).toHaveLength(2);
  });

  describe('polling', () => {
    const setHidden = (hidden: boolean) =>
      Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
    afterEach(() => setHidden(false));

    it('loads at once, then every minute while the page is visible', async () => {
      const { server, notifications: n } = store({ [LIST]: list([]) });

      n.startPolling();
      n.startPolling(); // a second start changes nothing
      await vi.advanceTimersByTimeAsync(0);
      expect(server.callsTo(LIST)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS);
      expect(server.callsTo(LIST)).toHaveLength(2);

      setHidden(true);
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS * 3);
      expect(server.callsTo(LIST)).toHaveLength(2);

      setHidden(false);
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(server.callsTo(LIST)).toHaveLength(3);
      n.stopPolling();
    });

    it('stops polling and forgets the items on reset', async () => {
      const { server, notifications: n } = store({ [LIST]: list([notification('a')]) });
      n.startPolling();
      await vi.advanceTimersByTimeAsync(0);
      expect(n.items).toHaveLength(1);

      n.reset();
      await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS * 2);
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);

      expect(server.callsTo(LIST)).toHaveLength(1);
      expect(n.items).toEqual([]);
      expect(n.unreadCount).toBe(0);
    });
  });
});
