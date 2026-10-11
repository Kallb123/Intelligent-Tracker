<script setup lang="ts">
import { changePasswordBodySchema } from '@tracker/shared';
import Button from 'primevue/button';
import Message from 'primevue/message';
import Password from 'primevue/password';
import { reactive, ref } from 'vue';
import { describeError, getApi } from '../api/index.js';
import FormField from '../components/FormField.vue';
import { useSessionStore } from '../stores/session.js';
import { confirmationError, validateForm, type FieldErrors } from '../validation.js';

const session = useSessionStore();

const form = reactive({ currentPassword: '', newPassword: '', confirmation: '' });
const errors = ref<FieldErrors>({});
const failure = ref('');
const done = ref(false);
const busy = ref(false);

async function submit(): Promise<void> {
  failure.value = '';
  done.value = false;
  const body = { currentPassword: form.currentPassword, newPassword: form.newPassword };
  const found = validateForm(changePasswordBodySchema, body) ?? {};
  const mismatch = confirmationError(form.newPassword, form.confirmation);
  if (mismatch) found['confirmation'] = mismatch;
  errors.value = found;
  if (Object.keys(found).length > 0) return;

  busy.value = true;
  try {
    await getApi().POST('/api/auth/password', { body });
    form.currentPassword = form.newPassword = form.confirmation = '';
    done.value = true;
  } catch (err) {
    failure.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Account</h1>
    </header>

    <section v-if="session.member" class="panel">
      <h2>You</h2>
      <dl class="details">
        <dt>Name</dt>
        <dd>{{ session.member.name }}</dd>
        <dt>Username</dt>
        <dd>{{ session.member.username }}</dd>
        <dt>Email</dt>
        <dd>{{ session.member.email ?? 'Not set' }}</dd>
        <dt>Role</dt>
        <dd>{{ session.member.role === 'admin' ? 'Admin' : 'Member' }}</dd>
        <dt>Household</dt>
        <dd>{{ session.household?.name }}</dd>
      </dl>
    </section>

    <form class="panel" novalidate @submit.prevent="submit">
      <h2>Change password</h2>
      <Message v-if="done" severity="success" role="status">
        Password changed. Your other devices have been logged out.
      </Message>
      <Message v-if="failure" severity="error" role="alert">{{ failure }}</Message>

      <FormField id="currentPassword" label="Current password" :error="errors['currentPassword']">
        <Password
          v-model="form.currentPassword"
          input-id="currentPassword"
          autocomplete="current-password"
          :feedback="false"
          toggle-mask
          :invalid="!!errors['currentPassword']"
          fluid
        />
      </FormField>
      <FormField
        id="newPassword"
        label="New password"
        hint="At least 10 characters."
        :error="errors['newPassword']"
      >
        <Password
          v-model="form.newPassword"
          input-id="newPassword"
          autocomplete="new-password"
          :feedback="false"
          toggle-mask
          :invalid="!!errors['newPassword']"
          fluid
        />
      </FormField>
      <FormField id="confirmation" label="Confirm new password" :error="errors['confirmation']">
        <Password
          v-model="form.confirmation"
          input-id="confirmation"
          autocomplete="new-password"
          :feedback="false"
          toggle-mask
          :invalid="!!errors['confirmation']"
          fluid
        />
      </FormField>
      <Button type="submit" label="Change password" :loading="busy" />
    </form>
  </div>
</template>
