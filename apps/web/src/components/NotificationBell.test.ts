import type { NotificationDto } from '@tracker/shared';
import { mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { afterEach, describe, expect, it } from 'vitest';
import NotificationBell from './NotificationBell.vue';

const notification = (
  id: string,
  kind: NotificationDto['payload']['kind'],
  readAt: string | null = null,
): NotificationDto => ({
  id,
  createdAt: '2026-10-13T08:00:00.000Z',
  readAt,
  payload: {
    type: 'reminder',
    kind,
    taskId: '33333333-3333-4333-8333-333333333333',
    occurrenceId: '44444444-4444-4444-8444-444444444444',
    taskTitle: 'Car insurance',
    dueDate: '2026-11-01',
    dueAt: null,
    fireAt: '2026-10-13T08:00:00.000Z',
    assigneeId: null,
    ...(kind === 'overdue' ? { overdueDays: 2 } : {}),
  },
});

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.replaceChildren();
});

function bell(notifications: NotificationDto[], unreadCount = notifications.length) {
  wrapper = mount(NotificationBell, {
    props: { notifications, unreadCount, timeZone: 'Europe/London' },
    global: { plugins: [PrimeVue] },
    attachTo: document.body,
  });
  return wrapper;
}

const button = (w: VueWrapper) => w.find('button[aria-haspopup="true"]');
// The popover is moved to the end of <body>, outside the wrapper.
const panel = () => document.body.querySelector('.bell-panel');
const items = () => [...document.body.querySelectorAll<HTMLButtonElement>('.bell-item')];
const markAll = () =>
  [...document.body.querySelectorAll<HTMLButtonElement>('.bell-header button')][0];

async function open(w: VueWrapper) {
  await button(w).trigger('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('NotificationBell', () => {
  it('shows the unread count on the bell', () => {
    const w = bell([notification('a', 'due'), notification('b', 'due', 'x')], 1);

    expect(button(w).attributes('aria-label')).toBe('Notifications, 1 unread');
    expect(w.find('.p-badge').text()).toBe('1');
  });

  it('caps a long count', () => {
    expect(bell([], 150).find('.p-badge').text()).toBe('99+');
  });

  it('has no badge when everything is read', () => {
    const w = bell([notification('a', 'due', 'x')], 0);

    expect(button(w).attributes('aria-label')).toBe('Notifications');
    expect(w.find('.p-badge').exists()).toBe(false);
  });

  it('lists the notifications as sentences, unread ones marked', async () => {
    const w = bell([notification('a', 'heads_up'), notification('b', 'overdue', 'x')], 1);

    await open(w);

    expect(panel()).not.toBeNull();
    expect(items().map((i) => i.querySelector('.bell-item-text')?.textContent)).toEqual([
      'Coming up: Car insurance (due 1 Nov 2026)',
      'Car insurance is 2 days overdue',
    ]);
    expect(items().map((i) => i.classList.contains('bell-item-unread'))).toEqual([true, false]);
  });

  it('says so when there are none', async () => {
    const w = bell([], 0);

    await open(w);

    expect(panel()?.textContent).toContain('No notifications yet.');
    expect(markAll()?.disabled).toBe(true);
  });

  it('emits select with the notification and closes when one is picked', async () => {
    const w = bell([notification('a', 'due'), notification('b', 'nudge')]);
    await open(w);

    items()[1]?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(w.emitted('select')).toEqual([[notification('b', 'nudge')]]);
  });

  it('emits markAllRead', async () => {
    const w = bell([notification('a', 'due')]);
    await open(w);

    markAll()?.click();

    expect(w.emitted('markAllRead')).toHaveLength(1);
  });
});
