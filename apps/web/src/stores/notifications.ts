import type { NotificationDto } from '@tracker/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { describeError, getApi } from '../api/index.js';

export const NOTIFICATION_POLL_MS = 60_000;

/**
 * The logged-in member's in-app notifications, for the bell. `startPolling` refreshes them every
 * minute while the page is visible (and straight away when it becomes visible again); `reset`
 * stops that and forgets everything, for when the layout goes away (logging out).
 */
export const useNotificationsStore = defineStore('notifications', () => {
  const items = ref<NotificationDto[]>([]);
  const unreadCount = ref(0);
  const error = ref('');
  let timer: ReturnType<typeof setInterval> | undefined;
  // Bumped by every `load`, `markRead`, `markAllRead` and `reset`. A load applies its result
  // only if nothing has bumped it since it started: an older load that lands late (a poll in
  // flight while a notification is marked read, or a visibility load racing the poll) would
  // otherwise overwrite newer state, and one in flight for the previous member (`reset`) would
  // write their notifications back.
  let sequence = 0;

  async function load(): Promise<void> {
    const started = (sequence += 1);
    try {
      const { data } = await getApi().GET('/api/notifications');
      if (started !== sequence) return;
      items.value = data?.items ?? [];
      unreadCount.value = data?.unreadCount ?? 0;
      error.value = '';
    } catch (err) {
      if (started !== sequence) return;
      // Keep what is shown; the next poll tries again.
      error.value = describeError(err);
    }
  }

  /** Marks one read on screen straight away, then tells the api (reloading if that fails). */
  async function markRead(id: string): Promise<void> {
    sequence += 1;
    const item = items.value.find((n) => n.id === id);
    if (item && item.readAt === null) {
      item.readAt = new Date().toISOString();
      unreadCount.value = Math.max(0, unreadCount.value - 1);
    }
    try {
      await getApi().POST('/api/notifications/{id}/read', { params: { path: { id } } });
    } catch {
      // Show what the api really has.
      await load();
    }
  }

  async function markAllRead(): Promise<void> {
    sequence += 1;
    const now = new Date().toISOString();
    for (const item of items.value) item.readAt ??= now;
    unreadCount.value = 0;
    try {
      await getApi().POST('/api/notifications/read-all');
    } catch {
      // Show what the api really has.
      await load();
    }
  }

  function refreshIfVisible(): void {
    if (!document.hidden) void load();
  }

  function startPolling(): void {
    if (timer !== undefined) return;
    void load();
    timer = setInterval(refreshIfVisible, NOTIFICATION_POLL_MS);
    document.addEventListener('visibilitychange', refreshIfVisible);
  }

  function stopPolling(): void {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
    document.removeEventListener('visibilitychange', refreshIfVisible);
  }

  /** Stops polling and forgets everything, so the next member never sees these. */
  function reset(): void {
    sequence += 1;
    stopPolling();
    items.value = [];
    unreadCount.value = 0;
    error.value = '';
  }

  return {
    items,
    unreadCount,
    error,
    load,
    markRead,
    markAllRead,
    startPolling,
    stopPolling,
    reset,
  };
});
