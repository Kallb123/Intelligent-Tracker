<script setup lang="ts">
import { computed } from 'vue';
import { useMembersStore } from '../stores/members.js';
import SelectField from './SelectField.vue';

/**
 * A "Person" select listing the household ("Everyone" is the empty string), for the Today,
 * Coming up and All tasks filters. The members must have been loaded by the page.
 */
const model = defineModel<string>({ required: true });
defineProps<{ id: string }>();

const membersStore = useMembersStore();
const options = computed(() => [
  { value: '', label: 'Everyone' },
  ...membersStore.members.map((m) => ({ value: m.id, label: m.name })),
]);
</script>

<template>
  <div class="field">
    <label :for="id">Person</label>
    <SelectField :id="id" v-model="model" :options="options" />
  </div>
</template>
