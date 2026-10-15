<script setup lang="ts">
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { ref } from 'vue';
import { formatDateTime } from '../format.js';
import { useSessionStore } from '../stores/session.js';

/**
 * Shows a one-time link (or other one-time text to copy, such as a bot command) with a copy
 * button; it is only ever shown once. The default slot adds extra actions above "Done".
 */
const props = withDefaults(
  defineProps<{
    title: string;
    description: string;
    link: { url: string; expiresAt: string };
    /** Accessible name of the copyable field. */
    label?: string;
  }>(),
  { label: 'One-time link' },
);
const emit = defineEmits<{ dismiss: [] }>();

const session = useSessionStore();
const copied = ref(false);
const copyFailed = ref(false);

async function copy(): Promise<void> {
  copied.value = false;
  copyFailed.value = false;
  try {
    await navigator.clipboard.writeText(props.link.url);
    copied.value = true;
  } catch {
    // No clipboard access (insecure origin, denied): the field is selectable instead.
    copyFailed.value = true;
  }
}
</script>

<template>
  <section class="link-box" aria-live="polite">
    <h2>{{ title }}</h2>
    <p>{{ description }}</p>
    <div class="link-row">
      <InputText
        :model-value="link.url"
        readonly
        fluid
        :aria-label="label"
        @focus="($event.target as HTMLInputElement).select()"
      />
      <Button
        type="button"
        :label="copied ? 'Copied' : 'Copy'"
        :icon="copied ? 'pi pi-check' : 'pi pi-copy'"
        severity="secondary"
        @click="copy"
      />
    </div>
    <p v-if="copyFailed" class="field-error" role="alert">
      Could not copy automatically. Select the link and copy it by hand.
    </p>
    <p class="muted">
      Works once. Expires on
      <time :datetime="link.expiresAt">{{ formatDateTime(link.expiresAt, session.timeZone) }}</time
      >.
    </p>
    <div v-if="$slots.default" class="button-row">
      <slot />
    </div>
    <Button type="button" label="Done" text size="small" @click="emit('dismiss')" />
  </section>
</template>
