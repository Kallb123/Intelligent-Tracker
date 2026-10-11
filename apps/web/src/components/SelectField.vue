<script setup lang="ts" generic="T extends string | number">
/**
 * A native `<select>` in the PrimeVue input style. Native on purpose: `<label for>`, keyboard use
 * and automated tests (`selectOption`) all work with no extra wiring, and it is the best picker
 * on phones.
 */
const model = defineModel<T>({ required: true });
defineProps<{
  id: string;
  options: readonly { value: T; label: string }[];
  invalid?: boolean;
}>();
</script>

<template>
  <select
    :id="id"
    v-model="model"
    class="p-inputtext p-component select-field"
    :aria-invalid="invalid || undefined"
  >
    <option v-for="option in options" :key="option.value" :value="option.value">
      {{ option.label }}
    </option>
  </select>
</template>
