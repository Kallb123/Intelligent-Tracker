<script setup lang="ts">
import type { SuggestionAction, SuggestionDto } from '@tracker/shared';
import Button from 'primevue/button';
import Message from 'primevue/message';
import { onMounted, ref } from 'vue';
import { describeError, getApi } from '../api/index.js';

const suggestions = ref<SuggestionDto[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const outcome = ref('');

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await getApi().GET('/api/suggestions');
    suggestions.value = data?.suggestions ?? [];
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function resolve(suggestion: SuggestionDto, action: SuggestionAction): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  outcome.value = '';
  try {
    await getApi().POST('/api/suggestions/{id}', {
      params: { path: { id: suggestion.id } },
      body: { action },
    });
    outcome.value =
      action === 'accept' ? 'Suggestion accepted. Task updated.' : 'Suggestion dismissed.';
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Suggestions</h1>
      <Button
        label="Refresh"
        icon="pi pi-refresh"
        severity="secondary"
        :disabled="busy || loading"
        @click="load"
      />
    </header>
    <p class="muted">Ideas from your household's task history. Nothing changes until you accept.</p>
    <Message v-if="error" severity="error" role="alert">{{ error }}</Message>
    <p v-if="outcome" role="status">{{ outcome }}</p>
    <p v-if="loading" class="muted">Loading…</p>
    <section v-else-if="!error && suggestions.length === 0" class="panel empty-state">
      <h2>No suggestions right now</h2>
      <p>Suggestions appear once a repeating task has enough completion history.</p>
    </section>
    <section
      v-for="suggestion in suggestions"
      v-else
      :key="suggestion.id"
      class="panel"
      :aria-label="suggestion.title"
    >
      <h2>
        <router-link :to="{ name: 'task-edit', params: { id: suggestion.taskId } }">{{
          suggestion.title
        }}</router-link>
      </h2>
      <p>{{ suggestion.message }}</p>
      <div class="button-row">
        <Button label="Accept" :disabled="busy" @click="resolve(suggestion, 'accept')" />
        <Button
          label="Dismiss"
          severity="secondary"
          :disabled="busy"
          @click="resolve(suggestion, 'dismiss')"
        />
      </div>
    </section>
  </div>
</template>
