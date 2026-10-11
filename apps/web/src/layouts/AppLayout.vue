<script setup lang="ts">
import Button from 'primevue/button';
import Menu from 'primevue/menu';
import type { MenuItem } from 'primevue/menuitem';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { describeError } from '../api/index.js';
import { useSessionStore } from '../stores/session.js';

/**
 * The shell around every page that needs a session: household name and user menu on top, and
 * the main navigation under it (a bottom tab bar on phones, where thumbs reach).
 */
const session = useSessionStore();
const router = useRouter();

const nav = [
  { to: { name: 'home' }, label: 'Today', icon: 'pi pi-home' },
  { to: { name: 'people' }, label: 'People', icon: 'pi pi-users' },
  { to: { name: 'account' }, label: 'Account', icon: 'pi pi-user' },
] as const;

const menu = ref<InstanceType<typeof Menu> | null>(null);
const logoutError = ref('');

async function logout(): Promise<void> {
  logoutError.value = '';
  try {
    // App.vue sends us to /login once the session is gone.
    await session.logout();
  } catch (err) {
    logoutError.value = describeError(err);
  }
}

const items: MenuItem[] = [
  { label: 'Account', icon: 'pi pi-user', command: () => void router.push({ name: 'account' }) },
  { label: 'Log out', icon: 'pi pi-sign-out', command: () => void logout() },
];
</script>

<template>
  <div class="layout">
    <header class="topbar">
      <router-link :to="{ name: 'home' }" class="brand">
        <i class="pi pi-check-circle" aria-hidden="true" />
        <span class="brand-name">{{ session.household?.name ?? 'Intelligent Tracker' }}</span>
      </router-link>

      <nav class="nav nav-top" aria-label="Main">
        <router-link v-for="item in nav" :key="item.label" :to="item.to">{{
          item.label
        }}</router-link>
      </nav>

      <div class="user">
        <Button
          type="button"
          :label="session.member?.name"
          icon="pi pi-user"
          severity="secondary"
          text
          aria-haspopup="true"
          aria-controls="user-menu"
          @click="menu?.toggle($event)"
        />
        <Menu id="user-menu" ref="menu" :model="items" popup />
      </div>
    </header>

    <div v-if="logoutError" class="banner-error" role="alert">{{ logoutError }}</div>

    <main class="content">
      <router-view />
    </main>

    <nav class="nav nav-bottom" aria-label="Main (mobile)">
      <router-link v-for="item in nav" :key="item.label" :to="item.to">
        <i :class="item.icon" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </router-link>
    </nav>
  </div>
</template>
