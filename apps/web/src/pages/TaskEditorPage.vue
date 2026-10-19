<script setup lang="ts">
import { defaultRecurrence, localToday, RecurrenceError, suggestLeadTime } from '@tracker/core';
import { taskBodySchema, type MemberDto } from '@tracker/shared';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Textarea from 'primevue/textarea';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { describeError, getApi } from '../api/index.js';
import FormField from '../components/FormField.vue';
import NumberInput from '../components/NumberInput.vue';
import RecurrenceBuilder from '../components/RecurrenceBuilder.vue';
import TemplatePicker from '../components/TemplatePicker.vue';
import SelectField from '../components/SelectField.vue';
import { useMembersStore } from '../stores/members.js';
import { useSessionStore } from '../stores/session.js';
import { useTaskDraftStore } from '../stores/task-draft.js';
import { memberLabel, moveItem } from '../tasks/rotation.js';
import {
  formatDue,
  formFromTask,
  milestoneProblem,
  newTaskForm,
  previewSchedule,
  PRIORITY_OPTIONS,
  taskBody,
  type TaskForm,
} from '../tasks/task-form.js';
import { validateForm, type FieldErrors } from '../validation.js';

/**
 * Create or edit a task (`/tasks/new`, `/tasks/:id`): the basics, when it is due and how it
 * repeats (with a live preview of the next dates from the same engine the worker runs), prep and
 * reminders, and who does it. Editing can also archive, restore or delete the task.
 */
const props = defineProps<{ id?: string }>();

const session = useSessionStore();
const membersStore = useMembersStore();
const drafts = useTaskDraftStore();
const router = useRouter();

const timeZone = computed(() => session.timeZone);
const isNew = computed(() => props.id === undefined);

const form = ref<TaskForm | null>(null);
const suggestedLead = computed(() => (form.value === null ? null : suggestLeadTime(form.value)));
const archived = ref(false);
/** Whose turn it is on the stored task, when it takes turns. */
const nextUpId = ref<string | null>(null);
const loading = ref(true);
const loadError = ref('');
const errors = ref<FieldErrors>({});
const saveError = ref('');
const saving = ref(false);
const confirmingDelete = ref(false);
const holidays = ref<ReadonlySet<string>>(new Set());
const holidayWarning = ref('');
onMounted(async () => {
  try {
    const { data } = await getApi().GET('/api/bank-holidays');
    if (data) holidays.value = new Set(data.holidays.map((h) => h.date));
    if (!data?.holidays.length)
      holidayWarning.value =
        'No cached bank holidays yet. The preview currently excludes weekends only.';
  } catch {
    holidayWarning.value = 'Bank holidays could not be loaded for the preview.';
  }
});

function startNew(): void {
  const today = localToday(new Date(), timeZone.value);
  // A draft is waiting when the quick-add sent us here with "Edit details".
  form.value = drafts.take() ?? newTaskForm(today, session.member?.id ?? '');
  archived.value = false;
  nextUpId.value = null;
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  errors.value = {};
  saveError.value = '';
  confirmingDelete.value = false;
  if (props.id === undefined) {
    startNew();
    loading.value = false;
    return;
  }
  try {
    const { data } = await getApi().GET('/api/tasks/{id}', { params: { path: { id: props.id } } });
    if (!data) return;
    form.value = formFromTask(data.task, timeZone.value);
    archived.value = data.task.archived;
    nextUpId.value = data.task.assignmentMode === 'rotation' ? data.task.nextAssigneeId : null;
  } catch (err) {
    form.value = null;
    loadError.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void membersStore.load());
watch(() => props.id, load, { immediate: true });

// Options for the selects.
const slotOptions = [
  { value: 'evening', label: 'Evening' },
  { value: 'morning', label: 'Morning' },
  { value: 'custom_time', label: 'Custom time' },
] as const;
const profileOptions = [
  { value: '', label: 'Household default' },
  { value: 'silent', label: 'Silent' },
  { value: 'gentle', label: 'Gentle' },
  { value: 'standard', label: 'Standard' },
  { value: 'persistent', label: 'Persistent' },
] as const;
const modeOptions = [
  { value: 'fixed', label: 'One person' },
  { value: 'any', label: 'Anyone' },
  { value: 'rotation', label: 'Take turns' },
] as const;
/** "Next up" only while that person is still in the rotation being edited. */
const nextUp = computed(() =>
  form.value?.assignmentMode === 'rotation' &&
  nextUpId.value &&
  form.value.rotation.includes(nextUpId.value)
    ? membersStore.nameOf(nextUpId.value)
    : '',
);
const today = computed(() => localToday(new Date(), timeZone.value));
/** A member's name, with when they are back if they are away right now. */
const labelFor = (m: MemberDto) => memberLabel(m, today.value);
const memberOptions = computed(() => [
  { value: '', label: 'Nobody in particular' },
  ...membersStore.members.map((m) => ({ value: m.id, label: labelFor(m) })),
]);
/** The rotation in turn order, for the move up / down list. */
const rotationMembers = computed(() =>
  (form.value?.rotation ?? []).map((id) => {
    const member = membersStore.byId.get(id);
    return {
      id,
      name: membersStore.nameOf(id),
      label: member ? labelFor(member) : membersStore.nameOf(id),
    };
  }),
);
const rotationNames = computed(() =>
  (form.value?.rotation ?? []).map((id) => membersStore.nameOf(id)).join(', then '),
);

// The live "next 5 dates".
const now = new Date();
const preview = computed(() =>
  form.value ? previewSchedule(form.value, timeZone.value, now, 5, holidays.value) : { dues: [] },
);

/** Said by the live region after a move, since the list itself is not announced. */
const moved = ref('');

/**
 * Moves someone in the rotation. The end buttons are `aria-disabled` rather than `disabled`, so
 * keyboard focus is never lost when a button reaches the end of the list; pressing one does
 * nothing. Focus is put back on the same button, which a reorder can otherwise drop.
 */
async function moveRotation(index: number, offset: -1 | 1): Promise<void> {
  const f = form.value;
  const id = f?.rotation[index];
  if (!f || id === undefined) return;
  const next = moveItem(f.rotation, index, offset);
  if (next[index] === id) return;
  f.rotation = next;
  moved.value = `${membersStore.nameOf(id)} moved to position ${next.indexOf(id) + 1}`;
  await nextTick();
  document.getElementById(`rotation-${offset < 0 ? 'up' : 'down'}-${id}`)?.focus();
}

function addMilestone(): void {
  form.value?.milestones.push({ title: '', days: null });
}
function removeMilestone(index: number): void {
  form.value?.milestones.splice(index, 1);
}

/**
 * Checks the form with the same rules the api applies. Returns the body to send, or undefined
 * with the field messages in `errors`. An unfinished repeat (no weekday ticked) is reported
 * alongside the other problems: the rest is checked as if the task did not repeat.
 */
function validate(f: TaskForm): ReturnType<typeof taskBody> | undefined {
  let body: ReturnType<typeof taskBody>;
  let repeatProblem: string | undefined;
  try {
    body = taskBody(f, timeZone.value);
  } catch (err) {
    if (!(err instanceof RecurrenceError)) throw err;
    repeatProblem = err.message;
    body = taskBody({ ...f, recurrence: defaultRecurrence('once') }, timeZone.value);
  }
  const milestones = milestoneProblem(f);
  errors.value = {
    ...validateForm(taskBodySchema, body),
    ...(milestones && { milestones }),
    ...(repeatProblem && { rrule: repeatProblem }),
  };
  return Object.keys(errors.value).length === 0 ? body : undefined;
}

async function save(): Promise<void> {
  saveError.value = '';
  if (!form.value) return;
  const body = validate(form.value);
  if (!body) {
    saveError.value = 'Some fields need attention. They are marked below.';
    return;
  }
  saving.value = true;
  try {
    if (props.id === undefined) {
      await getApi().POST('/api/tasks', { body });
    } else {
      await getApi().PATCH('/api/tasks/{id}', { params: { path: { id: props.id } }, body });
    }
    await router.push({ name: 'tasks' });
  } catch (err) {
    saveError.value = describeError(err);
  } finally {
    saving.value = false;
  }
}

async function setArchived(value: boolean): Promise<void> {
  if (props.id === undefined) return;
  saveError.value = '';
  try {
    await getApi().PATCH('/api/tasks/{id}', {
      params: { path: { id: props.id } },
      body: { archived: value },
    });
    await router.push({ name: 'tasks' });
  } catch (err) {
    saveError.value = describeError(err);
  }
}

async function remove(): Promise<void> {
  if (props.id === undefined) return;
  saveError.value = '';
  try {
    await getApi().DELETE('/api/tasks/{id}', { params: { path: { id: props.id } } });
    await router.push({ name: 'tasks' });
  } catch (err) {
    saveError.value = describeError(err);
    confirmingDelete.value = false;
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>{{ isNew ? 'New task' : 'Edit task' }}</h1>
      <span v-if="archived" class="muted">Archived</span>
    </header>

    <Message v-if="loadError" severity="error" role="alert">
      {{ loadError }}
      <router-link :to="{ name: 'tasks' }">Back to all tasks</router-link>
    </Message>
    <p v-else-if="loading || !form" class="muted">Loading…</p>

    <form v-else novalidate @submit.prevent="save">
      <Message v-if="saveError" severity="error" role="alert">{{ saveError }}</Message>

      <TemplatePicker v-model="form" :timezone="timeZone" />

      <section class="panel" aria-labelledby="basics-heading">
        <h2 id="basics-heading">The task</h2>
        <FormField id="task-title" label="Title" :error="errors['title']">
          <InputText id="task-title" v-model="form.title" :invalid="!!errors['title']" fluid />
        </FormField>
        <FormField id="task-notes" label="Notes" :error="errors['notes']">
          <Textarea id="task-notes" v-model="form.notes" rows="3" auto-resize fluid />
        </FormField>
        <FormField id="task-category" label="Category" hint="For example Home, Car or Garden.">
          <InputText
            id="task-category"
            v-model="form.category"
            :invalid="!!errors['category']"
            fluid
          />
        </FormField>
        <FormField id="task-tags" label="Tags" hint="Separate with commas." :error="errors['tags']">
          <InputText id="task-tags" v-model="form.tags" :invalid="!!errors['tags']" fluid />
        </FormField>
        <FormField id="task-priority" label="Priority">
          <SelectField id="task-priority" v-model="form.priority" :options="PRIORITY_OPTIONS" />
        </FormField>
        <FormField id="task-effort" label="Effort (minutes)" :error="errors['effortMinutes']">
          <NumberInput
            id="task-effort"
            v-model="form.effortMinutes"
            :min="1"
            :max="1440"
            :invalid="!!errors['effortMinutes']"
          />
        </FormField>
      </section>

      <section class="panel" aria-labelledby="when-heading">
        <h2 id="when-heading">When</h2>
        <p v-if="form.workingDaysOnly && holidayWarning" role="status">{{ holidayWarning }}</p>
        <div class="checkbox-row">
          <Checkbox v-model="form.workingDaysOnly" input-id="working-days" binary />
          <label for="working-days"
            >Working days only (move past weekends and cached bank holidays)</label
          >
        </div>
        <div class="checkbox-row">
          <Checkbox v-model="form.allDay" input-id="task-all-day" binary />
          <label for="task-all-day">All day</label>
        </div>
        <FormField
          id="task-due-date"
          label="Due date"
          :hint="
            form.recurrence.kind === 'once'
              ? undefined
              : 'Where the series starts. Later dates follow the repeat below.'
          "
          :error="errors['dueDate'] ?? errors['dueAt']"
        >
          <InputText
            id="task-due-date"
            v-model="form.dueDate"
            type="date"
            :invalid="!!(errors['dueDate'] ?? errors['dueAt'])"
            fluid
          />
        </FormField>
        <FormField v-if="!form.allDay" id="task-due-time" label="Due time">
          <InputText id="task-due-time" v-model="form.dueTime" type="time" fluid />
        </FormField>

        <RecurrenceBuilder v-model="form.recurrence" />
        <small
          v-if="errors['rrule'] ?? errors['intervalAfterCompletionDays']"
          class="field-error"
          role="alert"
          >{{ errors['rrule'] ?? errors['intervalAfterCompletionDays'] }}</small
        >

        <section class="preview" aria-labelledby="preview-heading">
          <h3 id="preview-heading">Next 5 dates</h3>
          <p v-if="'error' in preview" class="field-error" role="status">{{ preview.error }}</p>
          <template v-else>
            <ol v-if="preview.dues.length > 0" class="preview-dates">
              <li v-for="(due, i) in preview.dues" :key="i">{{ formatDue(due, timeZone) }}</li>
            </ol>
            <p v-else class="muted">No upcoming dates.</p>
            <p v-if="preview.note" class="muted">{{ preview.note }}</p>
          </template>
        </section>
      </section>

      <section class="panel" aria-labelledby="prep-heading">
        <h2 id="prep-heading">Prep and reminders</h2>
        <FormField
          id="remind-offset"
          label="Days before due for the due reminder"
          hint="Use 1 for the evening before bin collection. Other reminders keep their own dates."
        >
          <NumberInput
            id="remind-offset"
            :model-value="-form.remindOffsetDays"
            :min="0"
            :max="3650"
            @update:model-value="form.remindOffsetDays = -($event ?? 0)"
          />
        </FormField>
        <FormField
          id="task-lead"
          label="Lead time (days)"
          hint="Start showing it this many days before it is due."
          :error="errors['leadTimeDays']"
        >
          <NumberInput
            id="task-lead"
            v-model="form.leadTimeDays"
            :min="0"
            :max="3650"
            :invalid="!!errors['leadTimeDays']"
          />
        </FormField>

        <Message v-if="suggestedLead !== null" severity="info" :closable="false">
          This job takes {{ form.effortMinutes }} minutes. Allow {{ suggestedLead }} days to
          prepare?
          <Button
            type="button"
            :label="`Use ${suggestedLead}-day lead time`"
            severity="secondary"
            @click="form.leadTimeDays = suggestedLead"
          />
        </Message>

        <fieldset class="field milestones">
          <legend>Milestones</legend>
          <p class="muted">Steps on the way, such as "Get 3 quotes" 30 days before.</p>
          <div v-for="(m, i) in form.milestones" :key="i" class="milestone-row">
            <div class="field">
              <label :for="`milestone-${i}-name`">Milestone {{ i + 1 }} name</label>
              <InputText :id="`milestone-${i}-name`" v-model="m.title" fluid />
            </div>
            <div class="field">
              <label :for="`milestone-${i}-days`">Milestone {{ i + 1 }} days before due</label>
              <NumberInput :id="`milestone-${i}-days`" v-model="m.days" :min="0" :max="3650" />
            </div>
            <Button
              type="button"
              icon="pi pi-trash"
              severity="secondary"
              text
              :aria-label="`Remove milestone ${i + 1}`"
              @click="removeMilestone(i)"
            />
          </div>
          <small v-if="errors['milestones']" class="field-error" role="alert">{{
            errors['milestones']
          }}</small>
          <div>
            <Button
              type="button"
              label="Add milestone"
              icon="pi pi-plus"
              severity="secondary"
              outlined
              size="small"
              @click="addMilestone"
            />
          </div>
        </fieldset>

        <FormField id="task-profile" label="Reminder profile">
          <SelectField id="task-profile" v-model="form.reminderProfile" :options="profileOptions" />
        </FormField>
        <FormField id="task-slot" label="Reminder slot">
          <SelectField id="task-slot" v-model="form.reminderSlot" :options="slotOptions" />
        </FormField>
        <FormField
          v-if="form.reminderSlot === 'custom_time'"
          id="task-slot-time"
          label="Reminder time"
          :error="errors['reminderCustomTime']"
        >
          <InputText
            id="task-slot-time"
            v-model="form.reminderCustomTime"
            type="time"
            :invalid="!!errors['reminderCustomTime']"
            fluid
          />
        </FormField>
      </section>

      <section class="panel" aria-labelledby="who-heading">
        <h2 id="who-heading">Who</h2>
        <FormField id="task-mode" label="Assigned to">
          <SelectField id="task-mode" v-model="form.assignmentMode" :options="modeOptions" />
        </FormField>
        <FormField v-if="form.assignmentMode === 'fixed'" id="task-assignee" label="Person">
          <SelectField id="task-assignee" v-model="form.fixedAssignee" :options="memberOptions" />
        </FormField>
        <fieldset v-if="form.assignmentMode === 'rotation'" class="field">
          <legend>Take turns</legend>
          <div v-for="m in membersStore.members" :key="m.id" class="checkbox-row">
            <Checkbox v-model="form.rotation" :input-id="`rotation-${m.id}`" :value="m.id" />
            <label :for="`rotation-${m.id}`">{{ labelFor(m) }}</label>
          </div>
          <ol v-if="rotationMembers.length > 0" class="rotation-order" aria-label="Turn order">
            <li v-for="(m, i) in rotationMembers" :key="m.id">
              <span class="rotation-name">{{ i + 1 }}. {{ m.label }}</span>
              <Button
                :id="`rotation-up-${m.id}`"
                type="button"
                icon="pi pi-arrow-up"
                severity="secondary"
                text
                size="small"
                :aria-disabled="i === 0"
                :aria-label="`Move ${m.name} up`"
                @click="moveRotation(i, -1)"
              />
              <Button
                :id="`rotation-down-${m.id}`"
                type="button"
                icon="pi pi-arrow-down"
                severity="secondary"
                text
                size="small"
                :aria-disabled="i === rotationMembers.length - 1"
                :aria-label="`Move ${m.name} down`"
                @click="moveRotation(i, 1)"
              />
            </li>
          </ol>
          <p class="sr-only" role="status" aria-live="polite">{{ moved }}</p>
          <small class="muted">
            {{
              rotationNames ? `Order: ${rotationNames}.` : 'Tick the people who share this task.'
            }}
            Away people are skipped while they are away.
          </small>
          <small v-if="nextUp" class="muted">Next up: {{ nextUp }}</small>
          <small v-if="errors['assigneeIds']" class="field-error" role="alert">{{
            errors['assigneeIds']
          }}</small>
        </fieldset>
      </section>

      <div class="button-row editor-actions">
        <Button
          type="button"
          label="Cancel"
          severity="secondary"
          @click="router.push({ name: 'tasks' })"
        />
        <Button type="submit" label="Save task" icon="pi pi-check" :loading="saving" />
      </div>

      <section v-if="!isNew" class="panel danger-zone" aria-labelledby="danger-heading">
        <h2 id="danger-heading">Archive or delete</h2>
        <p class="muted">
          Archiving hides the task and its upcoming dates, and you can restore it later. Deleting
          removes it and its history for good.
        </p>
        <div v-if="confirmingDelete" class="button-row">
          <span>Delete this task for good?</span>
          <Button
            type="button"
            label="Keep task"
            severity="secondary"
            @click="confirmingDelete = false"
          />
          <Button
            type="button"
            label="Delete permanently"
            severity="danger"
            icon="pi pi-trash"
            @click="remove"
          />
        </div>
        <div v-else class="button-row">
          <Button
            v-if="archived"
            type="button"
            label="Restore task"
            icon="pi pi-replay"
            severity="secondary"
            @click="setArchived(false)"
          />
          <Button
            v-else
            type="button"
            label="Archive task"
            icon="pi pi-inbox"
            severity="secondary"
            @click="setArchived(true)"
          />
          <Button
            type="button"
            label="Delete task"
            icon="pi pi-trash"
            severity="danger"
            outlined
            @click="confirmingDelete = true"
          />
        </div>
      </section>
    </form>
  </div>
</template>
