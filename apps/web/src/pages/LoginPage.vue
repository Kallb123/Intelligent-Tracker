<script setup lang="ts">
import { loginBodySchema } from '@tracker/shared';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Password from 'primevue/password';
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { describeError } from '../api/index.js';
import AuthShell from '../components/AuthShell.vue';
import FormField from '../components/FormField.vue';
import { safeRedirect } from '../router.js';
import { useSessionStore } from '../stores/session.js';
import { validateForm, type FieldErrors } from '../validation.js';

const session = useSessionStore();
const router = useRouter();

const form = reactive({ identifier: '', password: '', remember: false });
const errors = ref<FieldErrors>({});
const failure = ref('');
const busy = ref(false);

async function submit(): Promise<void> {
  failure.value = '';
  errors.value = validateForm(loginBodySchema, form) ?? {};
  if (Object.keys(errors.value).length > 0) return;

  busy.value = true;
  try {
    await session.login({
      identifier: form.identifier.trim(),
      password: form.password,
      remember: form.remember,
    });
    await router.replace(safeRedirect(router.currentRoute.value.query['redirect']));
  } catch (err) {
    failure.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AuthShell title="Log in" subtitle="Welcome back.">
    <form novalidate @submit.prevent="submit">
      <Message v-if="failure" severity="error" role="alert">{{ failure }}</Message>

      <FormField id="identifier" label="Username or email" :error="errors['identifier']">
        <InputText
          id="identifier"
          v-model="form.identifier"
          autocomplete="username"
          autocapitalize="none"
          :invalid="!!errors['identifier']"
          fluid
          autofocus
        />
      </FormField>

      <FormField id="password" label="Password" :error="errors['password']">
        <Password
          v-model="form.password"
          input-id="password"
          autocomplete="current-password"
          :feedback="false"
          toggle-mask
          :invalid="!!errors['password']"
          fluid
        />
      </FormField>

      <div class="checkbox-row">
        <Checkbox v-model="form.remember" input-id="remember" binary />
        <label for="remember">Keep me logged in for 30 days</label>
      </div>

      <Button type="submit" label="Log in" :loading="busy" fluid />
    </form>
  </AuthShell>
</template>
