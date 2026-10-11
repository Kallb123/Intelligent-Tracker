<script setup lang="ts">
import { setupBodySchema } from '@tracker/shared';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Password from 'primevue/password';
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError, describeError } from '../api/index.js';
import AuthShell from '../components/AuthShell.vue';
import FormField from '../components/FormField.vue';
import { useSessionStore } from '../stores/session.js';
import { confirmationError, validateForm, type FieldErrors } from '../validation.js';

/** First-run wizard: step 1 names the household and you, step 2 creates your login. */
const session = useSessionStore();
const router = useRouter();

const step = ref<1 | 2>(1);
const form = reactive({
  householdName: '',
  name: '',
  username: '',
  email: '',
  password: '',
  confirmation: '',
  remember: true,
});
const errors = ref<FieldErrors>({});
const failure = ref('');
const busy = ref(false);
const alreadySetUp = ref(false);

function body() {
  const email = form.email.trim();
  return {
    householdName: form.householdName.trim(),
    name: form.name.trim(),
    username: form.username,
    ...(email && { email }),
    password: form.password,
    remember: form.remember,
  };
}

const stepOneSchema = setupBodySchema.pick({ householdName: true, name: true });

function next(): void {
  errors.value = validateForm(stepOneSchema, body()) ?? {};
  if (Object.keys(errors.value).length === 0) step.value = 2;
}

async function submit(): Promise<void> {
  failure.value = '';
  const found = validateForm(setupBodySchema, body()) ?? {};
  const mismatch = confirmationError(form.password, form.confirmation);
  if (mismatch) found['confirmation'] = mismatch;
  errors.value = found;
  if (Object.keys(found).length > 0) {
    // A problem on step 1 (e.g. after Back) must be visible.
    if (found['householdName'] || found['name']) step.value = 1;
    return;
  }

  busy.value = true;
  try {
    await session.setup(body());
    await router.replace({ name: 'home' });
  } catch (err) {
    failure.value = describeError(err);
    // Someone else finished setup first: the guard now sends visitors to the login page.
    if (err instanceof ApiError && err.status === 409) {
      session.needsSetup = false;
      alreadySetUp.value = true;
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AuthShell title="Welcome" :subtitle="`Set up your household. Step ${step} of 2.`">
    <form novalidate @submit.prevent="step === 1 ? next() : submit()">
      <Message v-if="failure" severity="error" role="alert">
        {{ failure }}
        <router-link v-if="alreadySetUp" to="/login">Go to log in</router-link>
      </Message>

      <template v-if="step === 1">
        <FormField
          id="householdName"
          label="Household name"
          hint="For example, The Smiths or 12 Acacia Road."
          :error="errors['householdName']"
        >
          <InputText
            id="householdName"
            v-model="form.householdName"
            :invalid="!!errors['householdName']"
            fluid
            autofocus
          />
        </FormField>
        <FormField id="name" label="Your name" :error="errors['name']">
          <InputText
            id="name"
            v-model="form.name"
            autocomplete="name"
            :invalid="!!errors['name']"
            fluid
          />
        </FormField>
        <Button type="submit" label="Next" icon="pi pi-arrow-right" icon-pos="right" fluid />
      </template>

      <template v-else>
        <p class="muted">
          You will be the household's admin and can invite everyone else afterwards.
        </p>
        <FormField
          id="username"
          label="Username"
          hint="Letters, digits, dots, dashes and underscores."
          :error="errors['username']"
        >
          <InputText
            id="username"
            v-model="form.username"
            autocomplete="username"
            autocapitalize="none"
            :invalid="!!errors['username']"
            fluid
          />
        </FormField>
        <FormField
          id="email"
          label="Email (optional)"
          hint="Lets you log in with your email too."
          :error="errors['email']"
        >
          <InputText
            id="email"
            v-model="form.email"
            type="email"
            autocomplete="email"
            :invalid="!!errors['email']"
            fluid
          />
        </FormField>
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
        <div class="button-row">
          <Button type="button" label="Back" severity="secondary" @click="step = 1" />
          <Button type="submit" label="Create household" :loading="busy" />
        </div>
      </template>
    </form>
  </AuthShell>
</template>
