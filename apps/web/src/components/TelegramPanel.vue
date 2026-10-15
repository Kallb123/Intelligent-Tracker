<script setup lang="ts">
import type { GroupLinkResponse, MemberLinkResponse, TelegramStatus } from '@tracker/shared';
import Button from 'primevue/button';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import { onMounted, ref } from 'vue';
import { describeError, getApi } from '../api/index.js';
import { useSessionStore } from '../stores/session.js';
import OneTimeLink from './OneTimeLink.vue';

/**
 * Connects Telegram: the logged-in member's own account and, for admins, the house group
 * (docs/PLAN.md 5.1). A code is shown once, right after it is issued; the bot redeems it, so the
 * status is fetched again to see whether that has happened.
 */
const session = useSessionStore();

const status = ref<TelegramStatus | null>(null);
const failure = ref('');
const busy = ref(false);

/** The codes on display, until dismissed or used. */
const memberLink = ref<MemberLinkResponse | null>(null);
const groupLink = ref<GroupLinkResponse | null>(null);
const confirmingGroupUnlink = ref(false);

/**
 * Fetches the status. A code on display is dropped when its link has just happened (the status
 * went from not linked to linked), not whenever the status says linked: an admin who is
 * replacing an already linked group is issued a code while `groupLinked` is true, and the
 * refresh that follows issuing it must not discard it.
 */
async function refresh(): Promise<void> {
  try {
    const { data } = await getApi().GET('/api/telegram');
    if (!data) return;
    const before = status.value;
    status.value = data;
    if (before && !before.memberLinked && data.memberLinked) memberLink.value = null;
    if (before && !before.groupLinked && data.groupLinked) groupLink.value = null;
  } catch (err) {
    failure.value = describeError(err);
  }
}

/** Runs a change, then refetches the status; the api's message is shown if it fails. */
async function act(change: () => Promise<void>): Promise<void> {
  failure.value = '';
  busy.value = true;
  try {
    await change();
    await refresh();
  } catch (err) {
    failure.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

const connect = () =>
  act(async () => {
    const { data } = await getApi().POST('/api/telegram/link');
    memberLink.value = data ?? null;
  });

const disconnect = () =>
  act(async () => {
    await getApi().DELETE('/api/telegram/link');
    memberLink.value = null;
  });

const linkGroup = () =>
  act(async () => {
    const { data } = await getApi().POST('/api/telegram/group-link');
    groupLink.value = data ?? null;
  });

const unlinkGroup = () =>
  act(async () => {
    await getApi().DELETE('/api/telegram/group-link');
    groupLink.value = null;
    confirmingGroupUnlink.value = false;
  });

onMounted(refresh);
</script>

<template>
  <Message v-if="failure" severity="error" role="alert">{{ failure }}</Message>

  <section class="panel" aria-labelledby="telegram-heading">
    <h2 id="telegram-heading">Telegram</h2>
    <p v-if="!status" class="muted">Loading…</p>
    <template v-else>
      <p>
        <Tag
          :value="status.memberLinked ? 'Connected' : 'Not connected'"
          :severity="status.memberLinked ? 'success' : 'secondary'"
        />
      </p>
      <p class="muted">
        Connect your Telegram account so the bot knows it is you when you tap a button in the house
        group.
      </p>
      <div class="button-row">
        <Button
          v-if="status.memberLinked"
          type="button"
          label="Disconnect"
          severity="secondary"
          :loading="busy"
          @click="disconnect"
        />
        <Button
          v-else
          type="button"
          label="Connect Telegram"
          icon="pi pi-telegram"
          :loading="busy"
          @click="connect"
        />
      </div>
    </template>
  </section>

  <OneTimeLink
    v-if="memberLink"
    :title="memberLink.url ? 'Open Telegram' : 'Send this to the bot'"
    :description="
      memberLink.url
        ? 'Open the link, then press Start in the chat with the bot. It links your account.'
        : 'Open a private chat with the bot and send it this message. It links your account.'
    "
    :link="{ url: memberLink.url ?? `/start ${memberLink.code}`, expiresAt: memberLink.expiresAt }"
    :label="memberLink.url ? 'Telegram link' : 'Message to send to the bot'"
    @dismiss="memberLink = null"
  >
    <Button
      v-if="memberLink.url"
      as="a"
      :href="memberLink.url"
      target="_blank"
      rel="noopener noreferrer"
      label="Open Telegram"
      icon="pi pi-external-link"
    />
    <Button
      type="button"
      label="Refresh status"
      icon="pi pi-refresh"
      severity="secondary"
      @click="refresh"
    />
  </OneTimeLink>

  <section v-if="session.isAdmin" class="panel" aria-labelledby="telegram-group-heading">
    <h2 id="telegram-group-heading">House group</h2>
    <p v-if="!status" class="muted">Loading…</p>
    <template v-else>
      <p>
        <Tag
          :value="status.groupLinked ? 'Linked' : 'Not linked'"
          :severity="status.groupLinked ? 'success' : 'secondary'"
        />
      </p>
      <p class="muted">
        Reminders go to one Telegram group chat. Add the bot to the house group, then send the
        command from here in that group.
      </p>
      <div v-if="confirmingGroupUnlink" class="button-row">
        <span>Stop sending reminders to the house group?</span>
        <Button
          type="button"
          label="Keep linked"
          severity="secondary"
          @click="confirmingGroupUnlink = false"
        />
        <Button
          type="button"
          label="Unlink group"
          severity="danger"
          :loading="busy"
          @click="unlinkGroup"
        />
      </div>
      <div v-else class="button-row">
        <Button
          v-if="status.groupLinked"
          type="button"
          label="Unlink group"
          severity="danger"
          outlined
          @click="confirmingGroupUnlink = true"
        />
        <Button
          type="button"
          :label="status.groupLinked ? 'Link a different group' : 'Link house group'"
          :severity="status.groupLinked ? 'secondary' : undefined"
          :loading="busy"
          @click="linkGroup"
        />
      </div>
    </template>
  </section>

  <OneTimeLink
    v-if="session.isAdmin && groupLink"
    title="Link the house group"
    description="Add the bot to the house group, then send this command in that group."
    :link="{ url: groupLink.command, expiresAt: groupLink.expiresAt }"
    label="Command to send in the house group"
    @dismiss="groupLink = null"
  >
    <Button
      type="button"
      label="Refresh status"
      icon="pi pi-refresh"
      severity="secondary"
      @click="refresh"
    />
  </OneTimeLink>
</template>
