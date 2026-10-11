<script setup lang="ts">
/** A small, muted line with the app version, shown at the bottom of every page. */
const version = __APP_VERSION__;
</script>

<template>
  <footer class="app-footer">v{{ version }}</footer>
</template>
