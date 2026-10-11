<script setup lang="ts">
import { setPasswordBodySchema } from '@tracker/shared';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import Message from 'primevue/message';
import Password from 'primevue/password';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, describeError, getApi } from '../api/index.js';
import AuthShell from '../components/AuthShell.vue';
import FormField from '../components/FormField.vue';
import { formatDateTime } from '../format.js';
import { useSessionStore } from '../stores/session.js';
import { confirmationError, validateForm, type FieldErrors } from '../validation.js';

/**
 * One page for both one-time links: `/invite/:token` (a new member joins) and
 * `/reset-password/:token` (an admin reset a password). They differ only in wording and endpoint.
 */
const props = defineProps<{ purpose: 'invite' | 'reset' }>();

interface LinkInfo {
  name: string;
  username: string;
  householdName: string;
  expiresAt: string;
}

const session = useSessionStore();
const route = useRoute();
const router = useRouter();
const token = computed(() => String(route.params['token'] ?? ''));

const loading = ref(true);
const info = ref<LinkInfo | null>(null);
/** Why the link cannot be used, when it cannot. */
const linkProblem = ref('');
const form = reactive({ password: '', confirmation: '', remember: false });
const errors = ref<FieldErrors>({});
const failure = ref('');
const busy = ref(false);

const noun = computed(() => (props.purpose === 'invite' ? 'invite' : 'password reset'));

function problemFor(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return `This ${noun.value} link is not valid. Check you copied all of it, or ask an admin for a new one.`;
  }
  if (err instanceof ApiError && err.status === 410) {
    return `This ${noun.value} link has expired or has already been used. Ask an admin for a new one.`;
  }
  return describeError(err);
}

onMounted(async () => {
  try {
    const path = { token: token.value };
    const { data } =
      props.purpose === 'invite'
        ? await getApi().GET('/api/invites/{token}', { params: { path } })
        : await getApi().GET('/api/password-resets/{token}', { params: { path } });
    info.value = data ?? null;
  } catch (err) {
    linkProblem.value = problemFor(err);
  } finally {
    loading.value = false;
  }
});

async function submit(): Promise<void> {
  failure.value = '';
  const found = validateForm(setPasswordBodySchema, form) ?? {};
  const mismatch = confirmationError(form.password, form.confirmation);
  if (mismatch) found['confirmation'] = mismatch;
  errors.value = found;
  if (Object.keys(found).length > 0) return;

  busy.value = true;
  try {
    const body = { password: form.password, remember: form.remember };
    if (props.purpose === 'invite') await session.acceptInvite(token.value, body);
    else await session.resetPassword(token.value, body);
    await router.replace({ name: 'home' });
  } catch (err) {
    const message = problemFor(err);
    // The link may have been used or expired since the page loaded.
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
      linkProblem.value = message;
    } else {
      failure.value = message;
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AuthShell
    :title="
      info
        ? purpose === 'invite'
          ? `Hi ${info.name}, join ${info.householdName}`
          : `Hi ${info.name}, choose a new password`
        : purpose === 'invite'
          ? 'Join your household'
          : 'Reset your password'
    "
  >
    <p v-if="loading" class="muted">Checking your link…</p>

    <template v-else-if="linkProblem">
      <Message severity="error" role="alert">{{ linkProblem }}</Message>
      <router-link to="/login">Go to log in</router-link>
    </template>

    <form v-else-if="info" novalidate @submit.prevent="submit">
      <p class="muted">
        {{ purpose === 'invite' ? 'Choose a password to finish joining.' : '' }}
        You will log in as <strong>{{ info.username }}</strong
        >. This link expires on {{ formatDateTime(info.expiresAt) }}.
      </p>

      <Message v-if="failure" severity="error" role="alert">{{ failure }}</Message>

      <FormField
        id="password"
        label="Password"
        hint="At least 10 characters."
        :error="errors['password']"
      >
        <Password
          v-model="form.password"
          input-id="password"
          autocomplete="new-password"
          :feedback="false"
          toggle-mask
          :invalid="!!errors['password']"
          fluid
        />
      </FormField>
      <FormField id="confirmation" label="Confirm password" :error="errors['confirmation']">
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
      <div class="checkbox-row">
        <Checkbox v-model="form.remember" input-id="remember" binary />
        <label for="remember">Keep me logged in for 30 days</label>
      </div>
      <Button
        type="submit"
        :label="purpose === 'invite' ? 'Join household' : 'Set password'"
        :loading="busy"
        fluid
      />
    </form>
  </AuthShell>
</template>
