<script setup lang="ts">
import { localToday } from '@tracker/core';
import { formatDayHeading, type OccurrenceDto } from '@tracker/shared';
import Button from 'primevue/button';
import Message from 'primevue/message';
import { computed, onMounted, ref } from 'vue';
import OccurrenceItem from '../components/OccurrenceItem.vue';
import PersonFilter from '../components/PersonFilter.vue';
import { useOccurrenceList } from '../composables/useOccurrenceList.js';
import { usePersonFilter } from '../composables/usePersonFilter.js';
import { formatTime } from '../format.js';
import { useMembersStore } from '../stores/members.js';
import { useSessionStore } from '../stores/session.js';
import { describePrepStart, groupByDate } from '../tasks/occurrences.js';

/**
 * Coming up: everything due from tomorrow on (and prep windows opening soon) for the next 30 or
 * 90 days, as a timeline by day.
 */
const session = useSessionStore();
const membersStore = useMembersStore();

const RANGES = [30, 90] as const;
const days = ref<(typeof RANGES)[number]>(30);
const { person, ready } = usePersonFilter();
const list = useOccurrenceList(() => ({
  view: 'upcoming',
  days: days.value,
  memberId: person.value,
  wait: !ready.value,
}));
onMounted(() => void membersStore.load());

const today = computed(() => localToday(new Date(), session.timeZone));
const groups = computed(() => groupByDate(list.occurrences.value, session.timeZone));

const heading = (date: string | null) =>
  date === null ? 'No date' : formatDayHeading(date, today.value);
const detail = (o: OccurrenceDto) =>
  o.dueAt && !o.task.allDay ? `Due at ${formatTime(o.dueAt, session.timeZone)}` : '';
const extra = (o: OccurrenceDto) => describePrepStart(o, today.value, session.timeZone);
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Coming up</h1>
      <div class="range-toggle" role="group" aria-label="How far ahead">
        <Button
          v-for="range in RANGES"
          :key="range"
          :label="`${range} days`"
          size="small"
          :severity="days === range ? undefined : 'secondary'"
          :outlined="days !== range"
          :aria-pressed="days === range"
          @click="days = range"
        />
      </div>
    </header>

    <form class="panel filters" role="search" aria-label="Filter coming up" @submit.prevent>
      <PersonFilter id="filter-person" v-model="person" />
    </form>

    <Message v-if="list.actionError.value" severity="error" role="alert">{{
      list.actionError.value
    }}</Message>
    <Message v-if="list.loadError.value" severity="error" role="alert">
      {{ list.loadError.value }}
      <Button label="Try again" text size="small" @click="list.load" />
    </Message>
    <p v-else-if="list.loading.value" class="muted">Loading…</p>

    <section v-else-if="groups.length === 0" class="panel empty-state">
      <h2>Nothing coming up</h2>
      <p>
        Nothing is due{{ person ? ` for ${membersStore.nameOf(person)}` : '' }} in the next
        {{ days }} days.
      </p>
    </section>

    <template v-else>
      <section v-for="group in groups" :key="group.date ?? 'none'" class="occurrence-group">
        <h2>{{ heading(group.date) }}</h2>
        <ul class="occurrence-list">
          <OccurrenceItem
            v-for="o in group.occurrences"
            :key="o.id"
            :occurrence="o"
            :detail="detail(o)"
            :extra="extra(o)"
            :assignee="membersStore.nameOf(o.assigneeId)"
            :busy="list.busyId.value === o.id"
            @complete="list.complete(o)"
            @start="list.start(o)"
            @snooze="(d) => list.snooze(o, d)"
          />
        </ul>
      </section>
    </template>
  </div>
</template>
