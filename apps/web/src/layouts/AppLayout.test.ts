import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNotificationsStore } from '../stores/notifications.js';
import { fakeServer, json, mountApp, session } from '../test-util.js';

const TASK_ID = '33333333-3333-4333-8333-333333333333';
const NOTIFICATION_ID = '55555555-5555-4555-8555-555555555555';

const unread = {
  id: NOTIFICATION_ID,
  createdAt: '2026-10-13T08:00:00.000Z',
  readAt: null,
  payload: {
    type: 'reminder',
    kind: 'nudge',
    taskId: TASK_ID,
    occurrenceId: '44444444-4444-4444-8444-444444444444',
    taskTitle: 'Car insurance',
    dueDate: '2026-11-01',
    dueAt: null,
    fireAt: '2026-10-13T08:00:00.000Z',
    assigneeId: null,
  },
};

afterEach(() => document.body.replaceChildren());

describe('AppLayout notification bell', () => {
  it('loads the notifications, and picking one marks it read and opens its task', async () => {
    const server = fakeServer({
      'GET /api/auth/me': json(session()),
      'GET /api/notifications': json({ items: [unread], unreadCount: 1 }),
      [`POST /api/notifications/${NOTIFICATION_ID}/read`]: new Response(null, { status: 204 }),
      'GET /api/occurrences': json({ occurrences: [] }),
      [`GET /api/tasks/${TASK_ID}`]: json({}, 404),
    });
    const { wrapper, router } = await mountApp(server, '/');

    const bell = wrapper.find('button[aria-label="Notifications, 1 unread"]');
    expect(bell.exists()).toBe(true);
    await bell.trigger('click');
    await flushPromises();
    const item = document.body.querySelector<HTMLButtonElement>('.bell-item');
    expect(item?.textContent).toContain('Reminder: Car insurance is due 1 Nov 2026');
    item?.click();
    await flushPromises();

    expect(server.callsTo(`POST /api/notifications/${NOTIFICATION_ID}/read`)).toHaveLength(1);
    // The editor page is loaded on demand.
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('task-edit'));
    expect(router.currentRoute.value.params['id']).toBe(TASK_ID);
    expect(useNotificationsStore().unreadCount).toBe(0);

    wrapper.unmount();
    expect(useNotificationsStore().items).toEqual([]);
  });
});
