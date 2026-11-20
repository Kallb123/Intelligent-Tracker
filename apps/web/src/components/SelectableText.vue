<script setup lang="ts">
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';

/**
 * Read-only text that selects itself on focus, for copying by hand when the clipboard is not
 * available. A textarea for several lines, a one-line field otherwise.
 */
withDefaults(
  defineProps<{
    id?: string | undefined;
    text: string;
    /** Accessible name of the field. */
    label: string;
    multiline?: boolean;
  }>(),
  { id: undefined, multiline: false },
);

function selectAll(event: FocusEvent): void {
  (event.target as HTMLInputElement | HTMLTextAreaElement).select();
}
</script>

<template>
  <Textarea
    v-if="multiline"
    :id="id"
    :model-value="text"
    readonly
    fluid
    rows="8"
    :aria-label="label"
    @focus="selectAll"
  />
  <InputText
    v-else
    :id="id"
    :model-value="text"
    readonly
    fluid
    :aria-label="label"
    @focus="selectAll"
  />
</template>
