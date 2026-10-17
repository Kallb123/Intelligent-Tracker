<script setup lang="ts">
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import { computed, watch } from 'vue';
import { useQuickAdd } from '../composables/useQuickAdd.js';
import { highlightMatches } from '../tasks/quick-add.js';

/**
 * Quick-add: type a task in plain English ("Car insurance renews 1/11 every year, sort it a
 * month before"), check what was understood on a preview card, then save it, edit its details in
 * the full task editor, or cancel. Nothing is saved before Save. `prefill` fills the bar and
 * opens the preview straight away (a link from Telegram); `saved` tells the page to refresh.
 */
const props = defineProps<{ prefill?: string | undefined }>();
const emit = defineEmits<{ saved: [] }>();

const { text, preview, error, busy, submit, save, editDetails, cancel } = useQuickAdd(() =>
  emit('saved'),
);

watch(
  () => props.prefill,
  (value) => {
    if (!value?.trim()) return;
    text.value = value;
    void submit();
  },
  { immediate: true },
);

const typed = computed(() =>
  preview.value ? highlightMatches(preview.value.text, preview.value.parse.matched) : [],
);
</script>

<template>
  <section class="panel quick-add" aria-label="Quick add">
    <form class="quick-add-row" @submit.prevent="submit">
      <label for="quick-add-text" class="sr-only">Quick add a task</label>
      <InputText
        id="quick-add-text"
        v-model="text"
        placeholder="Quick add, e.g. Car insurance renews 1/11 every year, sort it a month before"
        autocomplete="off"
        maxlength="500"
        fluid
      />
      <Button type="submit" label="Add" icon="pi pi-plus" :disabled="!text.trim() || busy" />
    </form>

    <Message v-if="error" severity="error" role="alert">{{ error }}</Message>

    <section v-if="preview" class="preview quick-add-preview" aria-label="Task preview">
      <h3>{{ preview.parse.task.title }}</h3>
      <p class="muted quick-add-typed">
        You typed:
        <template v-for="(segment, i) in typed" :key="i"
          ><mark v-if="segment.kind" :data-kind="segment.kind">{{ segment.text }}</mark
          ><template v-else>{{ segment.text }}</template></template
        >
      </p>
      <dl class="details">
        <template v-for="row in preview.rows" :key="row.label">
          <dt>{{ row.label }}</dt>
          <dd>{{ row.value }}</dd>
        </template>
      </dl>
      <div class="button-row quick-add-actions">
        <Button type="button" label="Cancel" severity="secondary" text @click="cancel" />
        <Button
          type="button"
          label="Edit details"
          severity="secondary"
          :disabled="busy"
          @click="editDetails"
        />
        <Button type="button" label="Save" :disabled="busy" @click="save" />
      </div>
    </section>
  </section>
</template>
