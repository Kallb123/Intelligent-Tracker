<script setup lang="ts">
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { useTemplateRef } from 'vue';

/**
 * A native date input that models `YYYY-MM-DD` ('' while empty), with a Clear button while it has
 * a value. Some mobile browsers (iOS Safari especially) cannot empty a native date input, so the
 * button is the only way to leave an optional date unset. `<label for>` works as usual.
 */
const model = defineModel<string>({ required: true });
defineProps<{
  id: string;
  /** Names the Clear button for assistive technology, such as "Clear due date". */
  clearLabel: string;
  min?: string;
  invalid?: boolean;
  ariaDescribedby?: string | undefined;
}>();

const input = useTemplateRef<{ $el: HTMLInputElement }>('input');

function clear(): void {
  model.value = '';
  input.value?.$el.focus();
}
</script>

<template>
  <div class="date-input">
    <InputText
      :id="id"
      ref="input"
      v-model="model"
      type="date"
      :min="min"
      :invalid="invalid"
      :aria-describedby="ariaDescribedby"
      fluid
    />
    <Button
      v-if="model"
      type="button"
      icon="pi pi-times"
      size="small"
      severity="secondary"
      text
      :aria-label="clearLabel"
      @click="clear"
    />
  </div>
</template>

<style scoped>
.date-input {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
</style>
