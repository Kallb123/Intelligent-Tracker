<script setup lang="ts">
import InputText from 'primevue/inputtext';

/**
 * A whole-number input that models `number | null` (null while empty), so forms can validate the
 * number rather than a string. A native `type="number"` input, so `<label for>` works as usual.
 */
const model = defineModel<number | null>({ required: true });
defineProps<{ id: string; min?: number; max?: number; invalid?: boolean }>();

function update(value: string | undefined): void {
  model.value = value === undefined || value.trim() === '' ? null : Number(value);
}
</script>

<template>
  <InputText
    :id="id"
    type="number"
    inputmode="numeric"
    :min="min"
    :max="max"
    :invalid="invalid"
    :model-value="model === null || Number.isNaN(model) ? '' : String(model)"
    fluid
    @update:model-value="update"
  />
</template>
