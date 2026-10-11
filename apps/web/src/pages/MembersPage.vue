<script setup lang="ts">
import type { MemberDto } from '@tracker/shared';
import { createInviteBodySchema } from '@tracker/shared';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Select from 'primevue/select';
import Tag from 'primevue/tag';
import { onMounted, reactive, ref } from 'vue';
import { describeError, getApi } from '../api/index.js';
import FormField from '../components/FormField.vue';
import OneTimeLink from '../components/OneTimeLink.vue';
import { useSessionStore } from '../stores/session.js';
import { validateForm, type FieldErrors } from '../validation.js';

const session = useSessionStore();

const members = ref<MemberDto[]>([]);
const loading = ref(true);
const loadError = ref('');

onMounted(load);

async function load(): Promise<void> {
  try {
    const { data } = await getApi().GET('/api/members');
    members.value = data?.members ?? [];
    loadError.value = '';
  } catch (err) {
    loadError.value = describeError(err);
  } finally {
    loading.value = false;
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
    <Message v-if="loadError" severity="error" role="alert">
      {{ loadError }}
      <Button label="Try again" text size="small" @click="load" />
    </Message>
    <p v-else-if="loading" class="muted">Loading…</p>

    <ul v-else class="member-list" aria-label="Household members">
      <li v-for="m in members" :key="m.id" class="member">
        <div class="member-main">
          <strong>{{ m.name }}</strong>
          <span v-if="m.id === session.member?.id" class="muted">(you)</span>
          <span class="muted">@{{ m.username }}</span>
          <span v-if="m.email" class="muted">{{ m.email }}</span>
        </div>
        <div class="member-tags">
          <Tag :value="m.role === 'admin' ? 'Admin' : 'Member'" severity="secondary" />
          <Tag v-if="m.pending" value="Pending" severity="warn" />
        </div>
        <Button
          v-if="session.isAdmin && m.id !== session.member?.id"
          :label="m.pending ? 'New invite link' : 'Reset password'"
          size="small"
          severity="secondary"
          outlined
          @click="resetPassword(m)"
        />
      </li>
    </ul>
  </div>
</template>
