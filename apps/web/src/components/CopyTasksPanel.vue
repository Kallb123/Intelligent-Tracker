<script setup lang="ts">
import { localToday } from '@tracker/core';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import { computed, ref } from 'vue';
import { describeError, getApi } from '../api/index.js';
import { useClipboard } from '../composables/useClipboard.js';
import SelectableText from './SelectableText.vue';
import { useMembersStore } from '../stores/members.js';
import { useSessionStore } from '../stores/session.js';
import {
  buildCopyList,
  COPY_LIMIT,
  queriesFor,
  wasCut,
  type CopyBucket,
} from '../tasks/copy-list.js';

/**
 * Buttons that copy the open tasks of a time range (today, this week, undated, all) as plain
 * text for a chat or notes app, optionally only the logged-in member's.
 */
const session = useSessionStore();
const membersStore = useMembersStore();
const clipboard = useClipboard();

const BUTTONS: { bucket: CopyBucket; label: string }[] = [
  { bucket: 'today', label: 'Copy today' },
  { bucket: 'week', label: 'Copy this week' },
  { bucket: 'undated', label: 'Copy undated' },
  { bucket: 'all', label: 'Copy all' },
];

const onlyMe = ref(false);
/** "Only me" needs to know who I am; without a member it is off rather than copying everyone's. */
const canOnlyMe = computed(() => session.member !== null);
const busy = ref(false);
const message = ref('');
const failed = ref(false);
/** The text the clipboard refused, shown so it can be selected by hand. */
const manualText = ref('');

async function copyBucket(bucket: CopyBucket): Promise<void> {
  busy.value = true;
  message.value = '';
  failed.value = false;
  manualText.value = '';
  try {
    const memberId = canOnlyMe.value && onlyMe.value ? session.member?.id : undefined;
    const [responses] = await Promise.all([
      Promise.all(
        queriesFor(bucket).map(({ view, days, limit }) =>
          getApi().GET('/api/occurrences', {
            params: {
              query: {
                view,
                limit,
                ...(days !== undefined && { days }),
                ...(memberId && { memberId }),
              },
            },
          }),
        ),
      ),
      membersStore.load(),
    ]);
    const cut = wasCut(responses.map((r) => r.data?.occurrences.length ?? 0));
    const { text, count } = buildCopyList(
      responses.flatMap((r) => r.data?.occurrences ?? []),
      {
        bucket,
        today: localToday(new Date(), session.timeZone),
        timeZone: session.timeZone,
        nameOf: membersStore.nameOf,
        cut,
      },
    );
    if (count === 0) {
      message.value = 'Nothing to copy';
    } else if (await clipboard.copy(text)) {
      message.value =
        `Copied ${count} ${count === 1 ? 'task' : 'tasks'}` +
        (cut ? ` (some lists may have been cut at ${COPY_LIMIT}; see the app for the rest)` : '');
    } else {
      failed.value = true;
      message.value = 'Could not copy to the clipboard';
      manualText.value = text;
    }
  } catch (err) {
    failed.value = true;
    message.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="panel copy-tasks" aria-label="Copy tasks">
    <div class="button-row">
      <Button
        v-for="b in BUTTONS"
        :key="b.bucket"
        type="button"
        :label="b.label"
        icon="pi pi-copy"
        severity="secondary"
        size="small"
        :disabled="busy"
        @click="copyBucket(b.bucket)"
      />
    </div>
    <div class="checkbox-row">
      <Checkbox v-model="onlyMe" input-id="copy-only-me" binary :disabled="!canOnlyMe" />
      <label for="copy-only-me">Only me</label>
    </div>
    <p class="muted" :class="{ 'field-error': failed }" aria-live="polite">{{ message }}</p>
    <SelectableText v-if="manualText" :text="manualText" label="Copy this text" multiline />
  </section>
</template>
