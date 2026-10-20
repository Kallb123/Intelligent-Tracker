<script setup lang="ts">
import { describeSchedule } from '@tracker/core';
import type { TaskDto } from '@tracker/shared';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { describeError, getApi } from '../api/index.js';
import PersonFilter from '../components/PersonFilter.vue';
import QuickAddBar from '../components/QuickAddBar.vue';
import SelectField from '../components/SelectField.vue';
import { usePersonFilter } from '../composables/usePersonFilter.js';
import { useMembersStore } from '../stores/members.js';
import { useSessionStore } from '../stores/session.js';
import { describeAssignees, nextUpName } from '../tasks/rotation.js';

/** All tasks: every task definition, with search, person / category / tag filters and quick-add. */
const session = useSessionStore();
const membersStore = useMembersStore();
const router = useRouter();

const tasks = ref<TaskDto[]>([]);
const loading = ref(true);
const loadError = ref('');
const showArchived = ref(false);

async function load(): Promise<void> {
  try {
    const { data } = await getApi().GET('/api/tasks', {
      params: { query: { archived: showArchived.value ? 'true' : 'false' } },
    });
    tasks.value = data?.tasks ?? [];
    loadError.value = '';
  } catch (err) {
    loadError.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  void membersStore.load();
});
watch(showArchived, () => void load());

// Filters: '' means "any".
const search = ref('');
const { person } = usePersonFilter();
const category = ref('');
const tag = ref('');

const distinct = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
const categories = computed(() =>
  distinct(tasks.value.flatMap((t) => (t.category ? [t.category] : []))),
);
const allTags = computed(() => distinct(tasks.value.flatMap((t) => t.tags)));

const categoryOptions = computed(() => [
  { value: '', label: 'All categories' },
  ...categories.value.map((c) => ({ value: c, label: c })),
]);
const tagOptions = computed(() => [
  { value: '', label: 'All tags' },
  ...allTags.value.map((t) => ({ value: t, label: t })),
]);

const visible = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return tasks.value.filter((t) => {
    if (person.value && !t.assigneeIds.includes(person.value)) return false;
    if (category.value && t.category !== category.value) return false;
    if (tag.value && !t.tags.includes(tag.value)) return false;
    if (!needle) return true;
    return [t.title, t.notes, t.category ?? '', ...t.tags].some((text) =>
      text.toLowerCase().includes(needle),
    );
  });
});

const filtering = computed(
  () => !!(search.value.trim() || person.value || category.value || tag.value),
);

const assignees = (t: TaskDto) => describeAssignees(t, membersStore.nameOf);
const nextUp = (t: TaskDto) => nextUpName(t, membersStore.nameOf);
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>All tasks</h1>
      <router-link :to="{ name: 'suggestions' }">Suggestions</router-link>
      <Button label="New task" icon="pi pi-plus" @click="router.push({ name: 'task-new' })" />
    </header>

    <QuickAddBar @saved="load" />

    <form class="panel filters" role="search" aria-label="Filter tasks" @submit.prevent>
      <div class="field">
        <label for="task-search">Search</label>
        <InputText
          id="task-search"
          v-model="search"
          type="search"
          placeholder="Title, notes, category or tag"
          fluid
        />
      </div>
      <PersonFilter id="filter-person" v-model="person" />
      <div class="field">
        <label for="filter-category">Category</label>
        <SelectField id="filter-category" v-model="category" :options="categoryOptions" />
      </div>
      <div class="field">
        <label for="filter-tag">Tag</label>
        <SelectField id="filter-tag" v-model="tag" :options="tagOptions" />
      </div>
      <div class="checkbox-row filters-archived">
        <Checkbox v-model="showArchived" input-id="show-archived" binary />
        <label for="show-archived">Show archived</label>
      </div>
    </form>

    <Message v-if="loadError" severity="error" role="alert">
      {{ loadError }}
      <Button label="Try again" text size="small" @click="load" />
    </Message>
    <p v-else-if="loading" class="muted">Loading…</p>

    <section v-else-if="tasks.length === 0" class="panel empty-state">
      <h2>{{ showArchived ? 'Nothing archived' : 'No tasks yet' }}</h2>
      <p v-if="!showArchived">Add the first one: bins, boiler service, car insurance.</p>
    </section>
    <p v-else-if="visible.length === 0" class="muted">No tasks match these filters.</p>

    <template v-else>
      <p class="muted" aria-live="polite">
        {{ visible.length }} {{ visible.length === 1 ? 'task' : 'tasks'
        }}{{ filtering ? ` of ${tasks.length}` : '' }}
      </p>
      <ul class="task-list" aria-label="Tasks">
        <li v-for="t in visible" :key="t.id" class="task-row">
          <div class="task-row-main">
            <router-link :to="{ name: 'task-edit', params: { id: t.id } }" class="task-title">{{
              t.title
            }}</router-link>
            <span class="muted">{{ describeSchedule(t, session.timeZone) }}</span>
            <span class="muted">For {{ assignees(t) }}</span>
            <span v-if="nextUp(t)" class="muted">Next: {{ nextUp(t) }}</span>
          </div>
          <div class="task-row-tags">
            <Tag v-if="t.archived" value="Archived" severity="warn" />
            <Tag v-if="t.category" :value="t.category" severity="info" />
            <Tag v-for="name in t.tags" :key="name" :value="name" severity="secondary" />
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>
