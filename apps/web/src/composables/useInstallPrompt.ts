import { computed, ref } from 'vue';

/**
 * The event Chromium browsers fire when the app can be installed. It is not in the DOM typings
 * yet.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** The held-back install prompt, or null when the browser has not offered one (or it was used). */
const deferred = ref<BeforeInstallPromptEvent | null>(null);

/**
 * Starts listening for the browser offering to install the app. It fires once, soon after the
 * page loads, usually before the page that shows the button is open, so `main.ts` calls this at
 * start-up and the event is kept until `useInstallPrompt().install()` uses it. Returns a function
 * that stops listening and forgets the event (for tests).
 */
export function listenForInstallPrompt(): () => void {
  const onPrompt = (event: Event): void => {
    // Stops the browser's own mini-infobar, so the app's button is the way to install.
    event.preventDefault();
    deferred.value = event as BeforeInstallPromptEvent;
  };
  const onInstalled = (): void => {
    deferred.value = null;
  };
  window.addEventListener('beforeinstallprompt', onPrompt);
  window.addEventListener('appinstalled', onInstalled);
  return () => {
    window.removeEventListener('beforeinstallprompt', onPrompt);
    window.removeEventListener('appinstalled', onInstalled);
    deferred.value = null;
  };
}

/** "Install app": whether the browser has offered to install the app, and the way to do it. */
export function useInstallPrompt() {
  /** Shows the browser's install dialog. The event can only be used once, either way. */
  async function install(): Promise<void> {
    const event = deferred.value;
    if (!event) return;
    deferred.value = null;
    await event.prompt();
    await event.userChoice;
  }

  return { canInstall: computed(() => deferred.value !== null), install };
}
