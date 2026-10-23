import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { createApp } from 'vue';
import 'primeicons/primeicons.css';
import App from './App.vue';
import { setApi } from './api/index.js';
import { listenForInstallPrompt } from './composables/useInstallPrompt.js';
import { registerServiceWorker } from './pwa.js';
import { createAppRouter } from './router.js';
import { createSessionApi } from './stores/session.js';
import './style.css';

/** Aura with a teal primary, matching the PWA theme colour. */
const Theme = definePreset(Aura, {
  semantic: {
    primary: {
      50: '{teal.50}',
      100: '{teal.100}',
      200: '{teal.200}',
      300: '{teal.300}',
      400: '{teal.400}',
      500: '{teal.500}',
      600: '{teal.600}',
      700: '{teal.700}',
      800: '{teal.800}',
      900: '{teal.900}',
      950: '{teal.950}',
    },
  },
});

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
// The client reads the CSRF token from the session store, so Pinia must be active first.
setApi(createSessionApi());
app.use(createAppRouter());
app.use(PrimeVue, { theme: { preset: Theme } });
app.mount('#app');

// The offline app shell and push notifications need the service worker (src/sw/sw.ts).
registerServiceWorker();
// The browser offers to install the app once, early, so it is caught here for the Account page.
listenForInstallPrompt();
