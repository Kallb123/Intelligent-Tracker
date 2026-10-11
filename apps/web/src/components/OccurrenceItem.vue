<script setup lang="ts">
import type { OccurrenceDto } from '@tracker/shared';
import Button from 'primevue/button';
import Menu from 'primevue/menu';
import type { MenuItem } from 'primevue/menuitem';
import Tag from 'primevue/tag';
import { computed, ref, useId } from 'vue';

/**
 * One occurrence in the Today and Coming up lists: title (linking to the task), when it is due,
 * and the one-click actions. The buttons are named after the task ("Complete Bins") so a screen
 * reader, or a test, can tell the rows apart.
 */
const props = defineProps<{
  occurrence: OccurrenceDto;
  /** When it is due, in words. */
  detail: string;
  /** Second line, such as when the prep window opens. */
  extra?: string;
  /** Who it is for; leave out when the list is already grouped by person. */
  assignee?: string;
  busy: boolean;
}>();

const emit = defineEmits<{
  complete: [];
  start: [];
  snooze: [days: number];
}>();

const title = computed(() => props.occurrence.task.title);
const started = computed(() => props.occurrence.status === 'started');
const important = computed(() => props.occurrence.task.priority >= 2);

const menuId = useId();
const menu = ref<InstanceType<typeof Menu> | null>(null);
const snoozeOptions: MenuItem[] = [
  { label: '1 day', days: 1 },
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
].map(({ label, days }) => ({ label, command: () => emit('snooze', days) }));
</script>

<template>
  <li class="occurrence" :class="{ 'occurrence-overdue': occurrence.overdue }">
    <div class="occurrence-main">
      <router-link
        :to="{ name: 'task-edit', params: { id: occurrence.taskId } }"
        class="occurrence-title"
        >{{ title }}</router-link
      >
      <span
        v-if="detail"
        class="occurrence-detail"
        :class="occurrence.overdue ? 'overdue-text' : 'muted'"
        >{{ detail }}</span
      >
      <span v-if="extra" class="occurrence-detail muted">{{ extra }}</span>
      <span class="occurrence-tags">
        <Tag v-if="assignee" :value="assignee" severity="secondary" />
        <Tag v-if="occurrence.task.category" :value="occurrence.task.category" severity="info" />
        <Tag
          v-if="important"
          :value="occurrence.task.priority >= 3 ? 'Urgent' : 'High'"
          severity="warn"
        />
        <Tag v-if="started" value="Started" severity="success" />
      </span>
    </div>
    <div class="occurrence-actions">
      <Button
        label="Complete"
        :aria-label="`Complete ${title}`"
        icon="pi pi-check"
        size="small"
        :loading="busy"
        @click="emit('complete')"
      />
      <Button
        v-if="!started"
        label="Start"
        :aria-label="`Start ${title}`"
        icon="pi pi-play"
        size="small"
        severity="secondary"
        outlined
        :disabled="busy"
        @click="emit('start')"
      />
      <Button
        label="Snooze"
        :aria-label="`Snooze ${title}`"
        icon="pi pi-clock"
        size="small"
        severity="secondary"
        outlined
        :disabled="busy"
        aria-haspopup="true"
        :aria-controls="menuId"
        @click="menu?.toggle($event)"
      />
      <Menu :id="menuId" ref="menu" :model="snoozeOptions" popup />
    </div>
  </li>
</template>
