<script setup lang="ts">
/** The centred card around the pages a visitor sees before they have a session. */
defineProps<{ title: string; subtitle?: string }>();
</script>

<template>
  <main class="auth-shell">
    <div class="auth-brand">
      <i class="pi pi-check-circle" aria-hidden="true" />
      <span>Intelligent Tracker</span>
    </div>
    <section class="auth-card">
      <h1>{{ title }}</h1>
      <p v-if="subtitle" class="muted">{{ subtitle }}</p>
      <slot />
    </section>
  </main>
</template>
