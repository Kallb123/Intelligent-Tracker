<script setup lang="ts">
import type { NotificationDto } from '@tracker/shared';
import Button from 'primevue/button';
import OverlayBadge from 'primevue/overlaybadge';
import Popover from 'primevue/popover';
import { computed, ref, useId } from 'vue';
import { formatRelative } from '../format.js';
import { describeReminder } from '../notifications/describe.js';

/**
 * The bell in the top bar: a button with the unread count that opens a list of the latest
 * notifications. It only shows what it is given; the caller loads them and decides what picking
 * one does (usually: mark it read and open its task).
 */
const props = defineProps<{
  notifications: NotificationDto[];
  unreadCount: number;
  /** The household's time zone, for the time of a timed due. */
  timeZone: string;
}>();

const emit = defineEmits<{
  select: [notification: NotificationDto];
  markAllRead: [];
}>();

const popoverId = useId();
const popover = ref<InstanceType<typeof Popover> | null>(null);
const label = computed(() =>
  props.unreadCount > 0 ? `Notifications, ${props.unreadCount} unread` : 'Notifications',
);
const badge = computed(() => (props.unreadCount > 99 ? '99+' : String(props.unreadCount)));

function select(notification: NotificationDto): void {
  popover.value?.hide();
  emit('select', notification);
}
</script>

<template>
  <div class="bell">
    <OverlayBadge v-if="unreadCount > 0" :value="badge" severity="danger" size="small">
      <Button
        type="button"
        icon="pi pi-bell"
        severity="secondary"
        text
        rounded
        :aria-label="label"
        aria-haspopup="true"
        :aria-controls="popoverId"
        @click="popover?.toggle($event)"
      />
    </OverlayBadge>
    <Button
      v-else
      type="button"
      icon="pi pi-bell"
      severity="secondary"
      text
      rounded
      :aria-label="label"
      aria-haspopup="true"
      :aria-controls="popoverId"
      @click="popover?.toggle($event)"
    />

    <Popover :id="popoverId" ref="popover">
      <div class="bell-panel">
        <div class="bell-header">
          <strong>Notifications</strong>
          <Button
            type="button"
            label="Mark all read"
            size="small"
            severity="secondary"
            text
            :disabled="unreadCount === 0"
            @click="emit('markAllRead')"
          />
        </div>
        <p v-if="notifications.length === 0" class="muted bell-empty">No notifications yet.</p>
        <ul v-else class="bell-list">
          <li v-for="n in notifications" :key="n.id">
            <button
              type="button"
              class="bell-item"
              :class="{ 'bell-item-unread': n.readAt === null }"
              @click="select(n)"
            >
              <span class="bell-item-text">{{ describeReminder(n.payload, timeZone) }}</span>
              <span class="bell-item-time muted">{{ formatRelative(n.createdAt) }}</span>
            </button>
          </li>
        </ul>
      </div>
    </Popover>
  </div>
</template>
