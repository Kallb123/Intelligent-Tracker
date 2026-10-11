<script setup lang="ts">
/** Label, control (slot) and validation message, wired together for screen readers. */
defineProps<{ id: string; label: string; error?: string | undefined; hint?: string | undefined }>();
</script>

<template>
  <div class="field">
    <label :for="id">{{ label }}</label>
    <slot />
    <small v-if="hint && !error" :id="`${id}-hint`" class="muted">{{ hint }}</small>
    <small v-if="error" :id="`${id}-error`" class="field-error" role="alert">{{ error }}</small>
  </div>
</template>
