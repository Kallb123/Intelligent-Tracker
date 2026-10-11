<script setup lang="ts">
import { localToday } from '@tracker/core';
import type { MemberDto, TaskDto } from '@tracker/shared';
import { createInviteBodySchema } from '@tracker/shared';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Select from 'primevue/select';
import Tag from 'primevue/tag';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { describeError, getApi } from '../api/index.js';
import FormField from '../components/FormField.vue';
import OneTimeLink from '../components/OneTimeLink.vue';
import { useMembersStore } from '../stores/members.js';
import { useSessionStore } from '../stores/session.js';
import { describeAway, isAway, nextUpName, rotationsOf } from '../tasks/rotation.js';
import { validateForm, type FieldErrors } from '../validation.js';

const session = useSessionStore();
const membersStore = useMembersStore();

const members = computed(() => membersStore.members);
const today = computed(() => localToday(new Date(), session.timeZone));

// Refetched on every visit: housemates may have joined or gone away since it was last loaded.
onMounted(() => {
  void membersStore.load(true);
  void loadTasks();
});

const load = () => membersStore.load(true);

/** The live tasks, to show who takes turns on what and whose turn it is. */
const tasks = ref<TaskDto[]>([]);
const tasksError = ref('');

async function loadTasks(): Promise<void> {
  try {
    const { data } = await getApi().GET('/api/tasks', { params: { query: { archived: 'false' } } });
    tasks.value = data?.tasks ?? [];
    tasksError.value = '';
  } catch (err) {
    tasksError.value = describeError(err);
  }
}

const rotations = (m: MemberDto) =>
  rotationsOf(tasks.value, m.id).map((t) => ({
    id: t.id,
    title: t.title,
    next: nextUpName(t, membersStore.nameOf),
  }));

// Away dates: a member sets their own, an admin anyone's (the api enforces that too).
const isSelf = (m: MemberDto) => m.id === session.member?.id;
const canSetAway = (m: MemberDto) => session.isAdmin || isSelf(m);
/** What is typed in each member's date box; absent until edited. */
const awayDrafts = reactive<Record<string, string>>({});
const awayErrors = reactive<Record<string, string>>({});
const awayBusy = reactive<Record<string, boolean>>({});

// A draft belongs to the date it was typed over: when the stored date changes (saved here, or
// reloaded after a housemate or admin changed it), the draft is dropped so it never wins.
watch(
  () => Object.fromEntries(members.value.map((m) => [m.id, m.awayUntil])),
  (now, before) => {
    for (const [id, awayUntil] of Object.entries(now)) {
      if (awayUntil !== before[id]) delete awayDrafts[id];
    }
  },
);

const awayDraft = (m: MemberDto) => awayDrafts[m.id] ?? (isAway(m, today.value) ? m.awayUntil : '');

async function setAway(m: MemberDto, awayUntil: string | null): Promise<void> {
  awayErrors[m.id] = '';
  if (awayUntil !== null && awayUntil < today.value) {
    awayErrors[m.id] = 'Choose today or a later date.';
    return;
  }
  awayBusy[m.id] = true;
  try {
    const { data } = await getApi().PATCH('/api/members/{id}/away', {
      params: { path: { id: m.id } },
      body: { awayUntil },
    });
    if (!data) return;
    membersStore.replace(data.member);
    delete awayDrafts[m.id];
    // Who is next on a rotation can change when someone goes away or comes back.
    void loadTasks();
  } catch (err) {
    awayErrors[m.id] = describeError(err);
  } finally {
    awayBusy[m.id] = false;
  }
}

// Invite form (admins only; the api enforces that too).
const roles = [
  { label: 'Member', value: 'member' },
  { label: 'Admin', value: 'admin' },
];
const showInvite = ref(false);
const form = reactive({ name: '', username: '', email: '', role: 'member' as 'member' | 'admin' });
const errors = ref<FieldErrors>({});
const inviteFailure = ref('');
const inviting = ref(false);

/** The one-time link on display: shown once, then gone. */
const shown = ref<{
  title: string;
  description: string;
  link: { url: string; expiresAt: string };
} | null>(null);
const actionFailure = ref('');

async function invite(): Promise<void> {
  inviteFailure.value = '';
  const email = form.email.trim();
  const body = {
    name: form.name.trim(),
    username: form.username,
    ...(email && { email }),
    role: form.role,
  };
  errors.value = validateForm(createInviteBodySchema, body) ?? {};
  if (Object.keys(errors.value).length > 0) return;

  inviting.value = true;
  try {
    const { data } = await getApi().POST('/api/invites', { body });
    if (!data) return;
    shown.value = {
      title: `Invite link for ${data.member.name}`,
      description: `Send this link to ${data.member.name}. They choose their own password, and you will see them here as pending until they do.`,
      link: data.invite,
    };
    form.name = form.username = form.email = '';
    form.role = 'member';
    showInvite.value = false;
    await load();
  } catch (err) {
    inviteFailure.value = describeError(err);
  } finally {
    inviting.value = false;
  }
}

async function resetPassword(target: MemberDto): Promise<void> {
  actionFailure.value = '';
  try {
    const { data } = await getApi().POST('/api/members/{id}/password-reset', {
      params: { path: { id: target.id } },
    });
    if (!data) return;
    shown.value = {
      title:
        data.purpose === 'invite'
          ? `New invite link for ${target.name}`
          : `Reset link for ${target.name}`,
      description:
        data.purpose === 'invite'
          ? `${target.name} has not joined yet. Send them this link instead of the old one.`
          : `Send this link to ${target.name}. Using it signs them out everywhere and lets them choose a new password.`,
      link: data.link,
    };
  } catch (err) {
    actionFailure.value = describeError(err);
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>People</h1>
      <Button
        v-if="session.isAdmin && !showInvite"
        label="Invite member"
        icon="pi pi-user-plus"
        @click="showInvite = true"
      />
    </header>

    <OneTimeLink
      v-if="shown"
      :title="shown.title"
      :description="shown.description"
      :link="shown.link"
      @dismiss="shown = null"
    />

    <form v-if="showInvite" class="panel" novalidate @submit.prevent="invite">
      <h2>Invite a member</h2>
      <Message v-if="inviteFailure" severity="error" role="alert">{{ inviteFailure }}</Message>
      <FormField id="invite-name" label="Name" :error="errors['name']">
        <InputText id="invite-name" v-model="form.name" :invalid="!!errors['name']" fluid />
      </FormField>
      <FormField
        id="invite-username"
        label="Username"
        hint="What they log in with."
        :error="errors['username']"
      >
        <InputText
          id="invite-username"
          v-model="form.username"
          autocapitalize="none"
          :invalid="!!errors['username']"
          fluid
        />
      </FormField>
      <FormField id="invite-email" label="Email (optional)" :error="errors['email']">
        <InputText
          id="invite-email"
          v-model="form.email"
          type="email"
          :invalid="!!errors['email']"
          fluid
        />
      </FormField>
      <FormField id="invite-role" label="Role" hint="Admins can invite people and reset passwords.">
        <Select
          v-model="form.role"
          input-id="invite-role"
          :options="roles"
          option-label="label"
          option-value="value"
          fluid
        />
      </FormField>
      <div class="button-row">
        <Button type="button" label="Cancel" severity="secondary" @click="showInvite = false" />
        <Button type="submit" label="Create invite link" :loading="inviting" />
      </div>
    </form>

    <Message v-if="actionFailure" severity="error" role="alert">{{ actionFailure }}</Message>
    <Message v-if="tasksError" severity="warn" role="alert">
      Could not load the rotations: {{ tasksError }}
    </Message>
    <Message v-if="membersStore.error" severity="error" role="alert">
      {{ membersStore.error }}
      <Button label="Try again" text size="small" @click="load" />
    </Message>
    <p v-else-if="!membersStore.loaded" class="muted">Loading…</p>

    <ul v-else class="member-list" aria-label="Household members">
      <li v-for="m in members" :key="m.id" class="member">
        <div class="member-main">
          <strong>{{ m.name }}</strong>
          <span v-if="isSelf(m)" class="muted">(you)</span>
          <span class="muted">@{{ m.username }}</span>
          <span v-if="m.email" class="muted">{{ m.email }}</span>
        </div>
        <div class="member-tags">
          <Tag :value="m.role === 'admin' ? 'Admin' : 'Member'" severity="secondary" />
          <Tag v-if="m.pending" value="Pending" severity="warn" />
          <Tag v-if="describeAway(m, today)" :value="describeAway(m, today)" severity="info" />
        </div>
        <Button
          v-if="session.isAdmin && !isSelf(m)"
          :label="m.pending ? 'New invite link' : 'Reset password'"
          size="small"
          severity="secondary"
          outlined
          @click="resetPassword(m)"
        />

        <form
          v-if="canSetAway(m)"
          class="away-form"
          role="group"
          :aria-label="`Away date for ${m.name}`"
          novalidate
          @submit.prevent="setAway(m, awayDraft(m) || null)"
        >
          <label :for="`away-${m.id}`">Away until</label>
          <InputText
            :id="`away-${m.id}`"
            :model-value="awayDraft(m)"
            type="date"
            :min="today"
            :invalid="!!awayErrors[m.id]"
            :aria-describedby="awayErrors[m.id] ? `away-${m.id}-error` : undefined"
            @update:model-value="awayDrafts[m.id] = $event ?? ''"
          />
          <Button
            type="submit"
            label="Save"
            size="small"
            :disabled="!awayDraft(m)"
            :loading="awayBusy[m.id]"
            :aria-label="`Save away date for ${m.name}`"
          />
          <Button
            v-if="isAway(m, today)"
            type="button"
            :label="isSelf(m) ? `I'm back` : 'Clear'"
            :aria-label="isSelf(m) ? `I'm back` : `Clear away date for ${m.name}`"
            size="small"
            severity="secondary"
            outlined
            :disabled="awayBusy[m.id]"
            @click="setAway(m, null)"
          />
          <small
            v-if="awayErrors[m.id]"
            :id="`away-${m.id}-error`"
            class="field-error"
            role="alert"
            >{{ awayErrors[m.id] }}</small
          >
        </form>

        <div v-if="rotations(m).length > 0" class="member-rotations">
          <span class="muted">Takes turns on</span>
          <ul :aria-label="`Rotations for ${m.name}`">
            <li v-for="r in rotations(m)" :key="r.id">
              <router-link :to="{ name: 'task-edit', params: { id: r.id } }">{{
                r.title
              }}</router-link>
              <span v-if="r.next" class="muted"> (next: {{ r.next }})</span>
            </li>
          </ul>
        </div>
      </li>
    </ul>
  </div>
</template>
