<script setup lang="ts">
import Button from 'primevue/button';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import { useInstallPrompt } from '../composables/useInstallPrompt.js';
import { usePushNotifications } from '../composables/usePushNotifications.js';

/**
 * Turns reminders as push notifications on or off for the browser being used (the Web Push
 * channel, see README). Each browser or phone is subscribed on its own, so this is a per-device
 * switch for the logged-in member. Also offers to install the app, which is what makes
 * notifications work on iPhones and iPads.
 */
const { state, busy, failure, enable, disable } = usePushNotifications();
const { canInstall, install } = useInstallPrompt();
</script>

<template>
  <Message v-if="failure" severity="error" role="alert">{{ failure }}</Message>

  <section class="panel" aria-labelledby="push-heading">
    <h2 id="push-heading">Notifications on this device</h2>
    <p v-if="state === 'loading'" class="muted">Loading…</p>

    <template v-else-if="state === 'subscribed' || state === 'unsubscribed'">
      <p>
        <Tag
          :value="state === 'subscribed' ? 'On' : 'Off'"
          :severity="state === 'subscribed' ? 'success' : 'secondary'"
        />
      </p>
      <p class="muted">
        Get your reminders as notifications on this device, even when the app is closed. Turn it on
        in each browser or phone you want them on.
      </p>
      <div class="button-row">
        <Button
          v-if="state === 'subscribed'"
          type="button"
          label="Turn off notifications"
          severity="secondary"
          :loading="busy"
          @click="disable"
        />
        <Button
          v-else
          type="button"
          label="Turn on notifications"
          icon="pi pi-bell"
          :loading="busy"
          @click="enable"
        />
      </div>
    </template>

    <template v-else>
      <p class="muted">
        <template v-if="state === 'needs-install'">
          On iPhone and iPad, notifications only work once the app is on your Home Screen. Tap the
          Share button in Safari, choose Add to Home Screen, then open Intelligent Tracker from
          there and come back to this page.
        </template>
        <template v-else-if="state === 'denied'">
          Notifications are blocked for this site. Allow them in your browser's site settings, then
          reload this page.
        </template>
        <template v-else-if="state === 'unconfigured'">
          Notifications have not been set up on this server. Ask whoever runs it to add push keys.
        </template>
        <template v-else-if="state === 'unsupported'">
          This browser cannot show notifications from the app. Try a recent version of Chrome, Edge,
          Firefox or Safari, or install the app.
        </template>
        <template v-else>We could not check whether notifications are available.</template>
      </p>
    </template>

    <div v-if="canInstall" class="button-row">
      <Button
        type="button"
        label="Install app"
        icon="pi pi-download"
        severity="secondary"
        @click="install"
      />
    </div>
  </section>
</template>
