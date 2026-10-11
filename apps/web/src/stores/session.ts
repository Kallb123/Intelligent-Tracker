import type { MemberDto, SessionInfo } from '@tracker/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiError, createApiClient, getApi, type ApiClient } from '../api/index.js';
import type { LoginInput, SetPasswordInput, SetupInput } from '../api/types.js';
import { DEFAULT_TIME_ZONE } from '../format.js';

/**
 * Who is logged in, and whether the household still needs its first-run setup.
 *
 * The session itself lives in an HTTP-only cookie the page cannot read; this store holds the
 * `SessionInfo` the api returns, including the CSRF token the api client sends on writes.
 */
export const useSessionStore = defineStore('session', () => {
  const info = ref<SessionInfo | null>(null);
  /** null until `GET /api/setup` has answered. Only asked while nobody is logged in. */
  const needsSetup = ref<boolean | null>(null);
  /** Set when start-up could not reach the api (anything but a plain 401). */
  const bootError = ref<ApiError | null>(null);
  let booting: Promise<void> | undefined;

  const member = computed<MemberDto | null>(() => info.value?.member ?? null);
  const household = computed(() => info.value?.household ?? null);
  const csrfToken = computed(() => info.value?.csrfToken);
  const isLoggedIn = computed(() => info.value !== null);
  const isAdmin = computed(() => info.value?.member.role === 'admin');
  const timeZone = computed(() => info.value?.household.timezone ?? DEFAULT_TIME_ZONE);

  /** Loads the current session and, if there is none, the setup status. Runs once. */
  function bootstrap(force = false): Promise<void> {
    if (force) booting = undefined;
    booting ??= (async () => {
      bootError.value = null;
      try {
        const { data } = await getApi().GET('/api/auth/me');
        info.value = data ?? null;
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.status !== 401) {
          bootError.value = err;
          return;
        }
        info.value = null;
      }
      if (!info.value) await refreshSetupStatus();
    })().catch((err: unknown) => {
      booting = undefined;
      throw err;
    });
    return booting;
  }

  async function refreshSetupStatus(): Promise<void> {
    try {
      const { data } = await getApi().GET('/api/setup');
      needsSetup.value = data?.needsSetup ?? null;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      bootError.value = err;
    }
  }

  function start(data: SessionInfo): SessionInfo {
    info.value = data;
    needsSetup.value = false;
    bootError.value = null;
    return data;
  }

  async function login(body: LoginInput): Promise<void> {
    const { data } = await getApi().POST('/api/auth/login', { body });
    if (data) start(data);
  }

  async function setup(body: SetupInput): Promise<void> {
    const { data } = await getApi().POST('/api/setup', { body });
    if (data) start(data);
  }

  async function acceptInvite(token: string, body: SetPasswordInput): Promise<void> {
    const { data } = await getApi().POST('/api/invites/{token}/accept', {
      params: { path: { token } },
      body,
    });
    if (data) start(data);
  }

  async function resetPassword(token: string, body: SetPasswordInput): Promise<void> {
    const { data } = await getApi().POST('/api/password-resets/{token}', {
      params: { path: { token } },
      body,
    });
    if (data) start(data);
  }

  async function logout(): Promise<void> {
    try {
      await getApi().POST('/api/auth/logout');
    } catch (err) {
      // Already logged out elsewhere is the outcome we wanted anyway.
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
    }
    info.value = null;
    // A household exists (we were in it), so the guards must not wait on /api/setup again.
    needsSetup.value = false;
  }

  /** The api said the session is gone (expired, signed out elsewhere, password changed). */
  function expire(): void {
    info.value = null;
  }

  return {
    info,
    needsSetup,
    bootError,
    member,
    household,
    csrfToken,
    isLoggedIn,
    isAdmin,
    timeZone,
    bootstrap,
    refreshSetupStatus,
    login,
    setup,
    acceptInvite,
    resetPassword,
    logout,
    expire,
  };
});

/**
 * The real client: CSRF token and "session ended" handling come from the session store.
 * `fetch` is injectable so tests can run the whole app without a network.
 */
export function createSessionApi(fetchFn?: typeof fetch): ApiClient {
  return createApiClient({
    ...(fetchFn && { fetch: fetchFn }),
    getCsrfToken: () => useSessionStore().csrfToken,
    onUnauthorized: () => {
      const session = useSessionStore();
      if (session.isLoggedIn) session.expire();
    },
  });
}
