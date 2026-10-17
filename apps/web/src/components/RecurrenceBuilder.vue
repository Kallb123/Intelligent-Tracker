<script setup lang="ts">
import Checkbox from 'primevue/checkbox';
import InputText from 'primevue/inputtext';
import {
  MONTH_NAMES,
  NTH_OPTIONS,
  REPEAT_KINDS,
  REPEAT_LABELS,
  WEEKDAY_CODES,
  WEEKDAY_NAMES,
  type RecurrenceState,
} from '@tracker/core';
import FormField from './FormField.vue';
import NumberInput from './NumberInput.vue';
import SelectField from './SelectField.vue';

/**
 * The "Repeats" picker and the fields of the chosen pattern. It only edits the state; turning it
 * into an RRULE (and the "next dates" preview) is the editor's job, so both stay in sync.
 */
const state = defineModel<RecurrenceState>({ required: true });

const kinds = REPEAT_KINDS.map((value) => ({ value, label: REPEAT_LABELS[value] }));
const weekdays = WEEKDAY_CODES.map((value) => ({ value, label: WEEKDAY_NAMES[value] }));
const months = MONTH_NAMES.map((label, i) => ({ value: i + 1, label }));
const monthlyModes = [
  { value: 'day', label: 'A day of the month' },
  { value: 'weekday', label: 'A weekday of the month' },
] as const;
</script>

<template>
  <div class="recurrence">
    <FormField id="repeat-kind" label="Repeats">
      <SelectField id="repeat-kind" v-model="state.kind" :options="kinds" />
    </FormField>

    <FormField v-if="state.kind === 'daily'" id="repeat-interval" label="Every how many days">
      <NumberInput id="repeat-interval" v-model="state.interval" :min="1" :max="999" />
    </FormField>

    <template v-if="state.kind === 'weekly'">
      <FormField
        id="repeat-interval"
        label="Every how many weeks"
        hint="1 is every week, 2 is every other week."
      >
        <NumberInput id="repeat-interval" v-model="state.interval" :min="1" :max="999" />
      </FormField>
      <fieldset class="field weekday-picker">
        <legend>On these days</legend>
        <div class="weekday-options">
          <div v-for="day in weekdays" :key="day.value" class="checkbox-row">
            <Checkbox
              v-model="state.weekdays"
              :input-id="`weekday-${day.value}`"
              :value="day.value"
            />
            <label :for="`weekday-${day.value}`">{{ day.label }}</label>
          </div>
        </div>
      </fieldset>
    </template>

    <template v-if="state.kind === 'monthly'">
      <FormField id="repeat-interval" label="Every how many months">
        <NumberInput id="repeat-interval" v-model="state.interval" :min="1" :max="999" />
      </FormField>
      <FormField id="monthly-mode" label="On">
        <SelectField id="monthly-mode" v-model="state.monthlyMode" :options="monthlyModes" />
      </FormField>
      <template v-if="state.monthlyMode === 'day'">
        <FormField
          v-if="!state.lastDay"
          id="month-day"
          label="Day of the month"
          hint="Months without that day are skipped."
        >
          <NumberInput id="month-day" v-model="state.monthDay" :min="1" :max="31" />
        </FormField>
        <div class="checkbox-row">
          <Checkbox v-model="state.lastDay" input-id="last-day" binary />
          <label for="last-day">Last day of the month</label>
        </div>
      </template>
      <template v-else>
        <FormField id="nth-week" label="Which one">
          <SelectField id="nth-week" v-model="state.nth" :options="NTH_OPTIONS" />
        </FormField>
        <FormField id="nth-weekday" label="Weekday">
          <SelectField id="nth-weekday" v-model="state.nthWeekday" :options="weekdays" />
        </FormField>
      </template>
    </template>

    <template v-if="state.kind === 'yearly'">
      <FormField id="repeat-interval" label="Every how many years">
        <NumberInput id="repeat-interval" v-model="state.interval" :min="1" :max="999" />
      </FormField>
      <FormField id="year-month" label="Month">
        <SelectField id="year-month" v-model="state.month" :options="months" />
      </FormField>
      <FormField
        v-if="!state.lastDay"
        id="month-day"
        label="Day of the month"
        hint="29 February only happens in leap years."
      >
        <NumberInput id="month-day" v-model="state.monthDay" :min="1" :max="31" />
      </FormField>
      <div class="checkbox-row">
        <Checkbox v-model="state.lastDay" input-id="last-day" binary />
        <label for="last-day">Last day of the month</label>
      </div>
    </template>

    <FormField
      v-if="state.kind === 'custom'"
      id="custom-rrule"
      label="Custom rule (RRULE)"
      hint="For example FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH"
    >
      <InputText
        id="custom-rrule"
        v-model="state.customRrule"
        autocapitalize="characters"
        spellcheck="false"
        fluid
      />
    </FormField>

    <FormField
      v-if="state.kind === 'after_completion'"
      id="after-days"
      label="Days after it is done"
      hint="The next one is due this many days after you complete the last. It drifts with reality, like descaling the kettle."
    >
      <NumberInput id="after-days" v-model="state.afterDays" :min="1" :max="3650" />
    </FormField>
  </div>
</template>
