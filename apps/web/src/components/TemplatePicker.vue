<script setup lang="ts">
import { suggestTemplates } from '@tracker/core';
import { UK_TEMPLATES, templateBodySchema, type Template } from '@tracker/shared';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import { computed, onMounted, ref, watch } from 'vue';
import { describeError, getApi } from '../api/index.js';
import { applyTemplate, templateFromForm } from '../tasks/templates.js';
import { parseTags, type TaskForm } from '../tasks/task-form.js';
import FormField from './FormField.vue';
import SelectField from './SelectField.vue';

const form = defineModel<TaskForm>({ required: true });
const props = defineProps<{ timezone: string }>();
const templates = ref<Template[]>([...UK_TEMPLATES]);
const selected = ref('');
const keywords = ref('');
const message = ref('');
const error = ref('');
const busy = ref(false);
const chosen = computed(() => templates.value.find((t) => t.id === selected.value));
const options = computed(() => [
  { value: '', label: 'Choose a template' },
  ...templates.value.map((t) => ({
    value: t.id,
    label: `${t.title}${t.builtIn ? ' (UK)' : ' (household)'}`,
  })),
]);
watch(chosen, (t) => {
  keywords.value = t?.keywords.join(', ') ?? '';
});
const suggestions = computed(() => suggestTemplates(form.value.title, templates.value));
onMounted(async () => {
  try {
    const { data } = await getApi().GET('/api/templates');
    if (data) templates.value = data.templates;
  } catch (err) {
    error.value = describeError(err);
  }
});

function apply(template: Template): void {
  try {
    form.value = applyTemplate(form.value, template, props.timezone);
    message.value = `Applied ${template.title}. Check the due date before saving.`;
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  }
}

async function save(replace: boolean): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    const parsed = templateBodySchema.parse(
      templateFromForm(form.value, props.timezone, parseTags(keywords.value)),
    );
    const body = {
      ...parsed,
      defaults: Object.fromEntries(
        Object.entries(parsed.defaults).filter(([, value]) => value !== undefined),
      ),
    };
    const id = chosen.value?.id;
    if (replace && (!id || chosen.value?.builtIn)) return;
    const result =
      replace && id
        ? await getApi().PATCH('/api/templates/{id}', { params: { path: { id } }, body })
        : await getApi().POST('/api/templates', { body });
    if (result.data) {
      templates.value = [
        ...templates.value.filter((t) => t.id !== result.data?.template.id),
        result.data.template,
      ];
      selected.value = result.data.template.id;
      message.value = 'Household template saved.';
    }
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  const template = chosen.value;
  if (!template || template.builtIn) return;
  error.value = '';
  busy.value = true;
  try {
    await getApi().DELETE('/api/templates/{id}', { params: { path: { id: template.id } } });
    templates.value = templates.value.filter((t) => t.id !== template.id);
    selected.value = '';
    message.value = 'Template deleted. Existing tasks are kept.';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="panel" aria-labelledby="templates-heading">
    <h2 id="templates-heading">Templates</h2>
    <Message v-if="error" severity="error" role="alert">{{ error }}</Message>
    <p v-if="message" role="status">{{ message }}</p>
    <div v-if="suggestions.length" class="button-row" aria-label="Suggested templates">
      <span>Suggested:</span>
      <Button
        v-for="t in suggestions"
        :key="t.id"
        type="button"
        severity="secondary"
        :label="t.title"
        @click="selected = t.id"
      />
    </div>
    <FormField id="task-template" label="Apply template">
      <SelectField id="task-template" v-model="selected" :options="options" />
    </FormField>
    <div v-if="chosen">
      <p>{{ chosen.defaults.notes }}</p>
      <p>
        Repeat: {{ chosen.defaults.rrule || chosen.defaults.scheduleKind || 'once' }}. Lead:
        {{ chosen.defaults.leadTimeDays ?? 0 }} days. Profile:
        {{ chosen.defaults.reminderProfile || 'household default' }}.
      </p>
      <ul v-if="chosen.defaults.milestones?.length">
        <li v-for="m in chosen.defaults.milestones" :key="m.title">
          {{ m.title }} — {{ m.offsetDaysBeforeDue }} days before
        </li>
      </ul>
      <p class="muted">
        Replaces notes, category, repeat, prep and reminder settings. Your title and people are
        kept. Calendar rules may move the due date to the next matching date.
      </p>
      <Button type="button" label="Apply template" @click="apply(chosen)" />
    </div>
    <details>
      <summary>Save or manage a household template</summary>
      <p class="muted">
        Save the current task settings without its date or people. To change a template, apply it,
        edit the task settings, then replace it here.
      </p>
      <FormField id="template-keywords" label="Keywords (comma-separated)">
        <InputText id="template-keywords" v-model="keywords" fluid />
      </FormField>
      <div class="button-row">
        <Button
          type="button"
          label="Save as template"
          :disabled="!form.title.trim() || busy"
          @click="save(false)"
        />
        <Button
          v-if="chosen && !chosen.builtIn"
          type="button"
          label="Replace selected template"
          :disabled="busy"
          @click="save(true)"
        />
        <Button
          v-if="chosen && !chosen.builtIn"
          type="button"
          label="Delete selected template"
          severity="danger"
          :disabled="busy"
          @click="remove"
        />
      </div>
    </details>
  </section>
</template>
