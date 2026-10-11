<script setup lang="ts">
import Button from 'primevue/button';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import AuthShell from '../components/AuthShell.vue';
import { useSessionStore } from '../stores/session.js';

/** Shown when start-up could not reach the api (it may still be booting). */
const session = useSessionStore();
const router = useRouter();
const busy = ref(false);

async function retry(): Promise<void> {
  busy.value = true;
  try {
    await session.bootstrap(true);
    // The guard sends us to the right page, or straight back here if the api is still down.
    await router.replace({ name: 'home' });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AuthShell title="Cannot reach the server">
    <p>{{ session.bootError?.message ?? 'Something went wrong while starting up.' }}</p>
    <Button label="Try again" icon="pi pi-refresh" :loading="busy" fluid @click="retry" />
  </AuthShell>
</template>
