<script setup lang="ts">
import { localToday } from '@tracker/core';
import type { OccurrenceDto } from '@tracker/shared';
import Button from 'primevue/button';
import Message from 'primevue/message';
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import OccurrenceItem from '../components/OccurrenceItem.vue';
import PersonFilter from '../components/PersonFilter.vue';
import { useOccurrenceList } from '../composables/useOccurrenceList.js';
import { usePersonFilter } from '../composables/usePersonFilter.js';
import { formatDayHeading } from '../format.js';
import { useMembersStore } from '../stores/members.js';
import { useSessionStore } from '../stores/session.js';
import { describeDue, describePrepStart, groupByAssignee } from '../tasks/occurrences.js';

/**
 * Today: what is overdue, then what is due today (or already in its prep window, or undated),
 * grouped by person, each with one-click Complete, Start and Snooze.
 */
const session = useSessionStore();
const membersStore = useMembersStore();
const router = useRouter();

const { person, ready } = usePersonFilter();
const list = useOccurrenceList(() => ({
  view: 'today',
  memberId: person.value,
  wait: !ready.value,
}));
onMounted(() => void membersStore.load());

const today = computed(() => localToday(new Date(), session.timeZone));
const heading = computed(() => formatDayHeading(today.value, undefined, true));

const overdue = computed(() => list.occurrences.value.filter((o) => o.overdue));
const groups = computed(() =>
  groupByAssignee(
    list.occurrences.value.filter((o) => !o.overdue),
    membersStore.members,
    session.member?.id,
  ),
);

const detail = (o: OccurrenceDto) => describeDue(o, today.value, session.timeZone);
const extra = (o: OccurrenceDto) => describePrepStart(o, today.value, session.timeZone);
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div>
        <h1>Today</h1>
        <p class="muted page-subtitle">{{ heading }}</p>
      </div>
      <Button label="New task" icon="pi pi-plus" @click="router.push({ name: 'task-new' })" />
    </header>

    <form class="panel filters" role="search" aria-label="Filter today" @submit.prevent>
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

    <section v-else-if="list.occurrences.value.length === 0" class="panel empty-state">
      <h2>All clear</h2>
      <p v-if="person">Nothing is due today for {{ membersStore.nameOf(person) }}.</p>
      <p v-else>
        Nothing is due today. Have a look at what is
        <router-link :to="{ name: 'upcoming' }">coming up</router-link>, or
        <router-link :to="{ name: 'task-new' }">add a task</router-link>.
      </p>
    </section>

    <template v-else>
      <section v-if="overdue.length > 0" aria-labelledby="overdue-heading" class="occurrence-group">
        <h2 id="overdue-heading" class="overdue-text">Overdue</h2>
        <ul class="occurrence-list">
          <OccurrenceItem
            v-for="o in overdue"
            :key="o.id"
            :occurrence="o"
            :detail="detail(o)"
            :assignee="membersStore.nameOf(o.assigneeId)"
            :busy="list.busyId.value === o.id"
            @complete="list.complete(o)"
            @start="list.start(o)"
            @snooze="(days) => list.snooze(o, days)"
          />
        </ul>
      </section>

      <section
        v-for="group in groups"
        :key="group.key"
        :aria-label="`Today: ${group.name}`"
        class="occurrence-group"
      >
        <h2>{{ group.name }}</h2>
        <ul class="occurrence-list">
          <OccurrenceItem
            v-for="o in group.occurrences"
            :key="o.id"
            :occurrence="o"
            :detail="detail(o)"
            :extra="extra(o)"
            :busy="list.busyId.value === o.id"
            @complete="list.complete(o)"
            @start="list.start(o)"
            @snooze="(days) => list.snooze(o, days)"
          />
        </ul>
      </section>
    </template>
  </div>
</template>
