<script setup lang="ts">
import {
  TELEGRAM_NOTIFICATION_TYPES,
  type GroupLinkResponse,
  type MemberLinkResponse,
  type TelegramNotificationType,
  type TelegramStatus,
} from '@tracker/shared';
import Button from 'primevue/button';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import ToggleSwitch from 'primevue/toggleswitch';
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

/**
 * What each switch is called and does. Keyed by type, so a new notification type fails the type
 * check until it has copy here.
 */
const NOTIFICATION_COPY: Record<TelegramNotificationType, { label: string; description: string }> =
  {
    heads_up: {
      label: 'Heads-ups',
      description: 'The first reminder of a job, when its preparation window opens.',
    },
    milestone: {
      label: 'Milestones',
      description: 'Reminders for the steps of a job, on the day each one is due.',
    },
    nudge: {
      label: 'Nudges',
      description: 'Reminders between the heads-up and the due day, for jobs not yet done.',
    },
    due: {
      label: 'Due today',
      description: 'The reminder on the day a job is due.',
    },
    overdue: {
      label: 'Overdue',
      description: 'Repeat reminders for a job that is past its due date.',
    },
    morning: {
      label: 'Morning digest',
      description: "The day's jobs, posted every morning.",
    },
    week_ahead: {
      label: 'Week ahead',
      description: "The coming week's jobs, posted on Sunday evenings.",
    },
  };

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

/** The switches whose save is still in flight. */
const saving = ref<TelegramNotificationType[]>([]);

/**
 * Saves one switch straight away. The switch moves first; if the save fails it moves back and
 * the api's message is shown. On success the server's record is the truth.
 */
async function setNotification(type: TelegramNotificationType, on: boolean): Promise<void> {
  if (!status.value || saving.value.includes(type)) return;
  const before = status.value.notifications[type];
  failure.value = '';
  status.value.notifications[type] = on;
  saving.value.push(type);
  // Only this switch's key is written back, into whatever status is current by then: another
  // switch may be saving at the same time, and a refresh may have replaced the status.
  try {
    const { data } = await getApi().PATCH('/api/telegram/notifications', { body: { [type]: on } });
    if (!data) throw new Error('The change was not saved');
    if (status.value) status.value.notifications[type] = data.notifications[type];
  } catch (err) {
    if (status.value) status.value.notifications[type] = before;
    failure.value = describeError(err);
  } finally {
    saving.value = saving.value.filter((t) => t !== type);
  }
}

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
      <template v-if="status.groupLinked">
        <h3 id="telegram-notifications-heading">What the bot posts</h3>
        <p class="muted">
          Choose which messages the bot posts in the house group. In-app and phone notifications are
          not affected.
        </p>
        <ul class="notification-list" aria-labelledby="telegram-notifications-heading">
          <li v-for="type in TELEGRAM_NOTIFICATION_TYPES" :key="type" class="notification-row">
            <ToggleSwitch
              :model-value="status.notifications[type]"
              :input-id="`telegram-notify-${type}`"
              :disabled="saving.includes(type)"
              :pt="{ input: { 'aria-describedby': `telegram-notify-${type}-description` } }"
              @update:model-value="setNotification(type, $event)"
            />
            <div>
              <label :for="`telegram-notify-${type}`">{{ NOTIFICATION_COPY[type].label }}</label>
              <p :id="`telegram-notify-${type}-description`" class="muted">
                {{ NOTIFICATION_COPY[type].description }}
              </p>
            </div>
          </li>
        </ul>
      </template>
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

<style scoped>
.notification-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.notification-row {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}

.notification-row label {
  font-weight: 600;
}

.notification-row p {
  margin: 0;
}
</style>
