<script setup lang="ts">
import { watch } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from './stores/session.js';

const session = useSessionStore();
const router = useRouter();

// Logging out, or the api ending the session (expiry, password changed elsewhere), sends the
// visitor to the login page from wherever they are. Public pages stay put.
watch(
  () => session.isLoggedIn,
  (loggedIn) => {
    if (!loggedIn && !router.currentRoute.value.meta.public) void router.replace({ name: 'login' });
  },
);
</script>

<template>
  <router-view />
</template>
