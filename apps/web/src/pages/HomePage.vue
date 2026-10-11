<script setup lang="ts">
import { useSessionStore } from '../stores/session.js';

const session = useSessionStore();
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Today</h1>
    </header>
    <section class="panel">
      <h2>Hi {{ session.member?.name }}</h2>
      <p>
        You are in <strong>{{ session.household?.name }}</strong
        >. Task views arrive next: what is due today, what is coming up, and everything else.
      </p>
      <p class="muted">
        In the meantime, see who else is in the household on the
        <router-link :to="{ name: 'people' }">People</router-link> page.
      </p>
    </section>
  </div>
</template>
