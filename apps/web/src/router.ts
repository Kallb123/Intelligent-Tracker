import {
  createRouter,
  createWebHistory,
  type RouteLocationRaw,
  type Router,
  type RouterHistory,
} from 'vue-router';
import { loadPendingUpdate } from './pwa.js';
import { useSessionStore } from './stores/session.js';

declare module 'vue-router' {
  interface RouteMeta {
    /** Reachable without logging in. */
    public?: boolean;
    /** Only for logged-out visitors (the login page); members are sent home instead. */
    guestOnly?: boolean;
    title?: string;
  }
}

export const routes = [
  {
    path: '/setup',
    name: 'setup',
    component: () => import('./pages/SetupPage.vue'),
    meta: { public: true, title: 'Set up' },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('./pages/LoginPage.vue'),
    meta: { public: true, guestOnly: true, title: 'Log in' },
  },
  // The api builds these two links (see PUBLIC_BASE_URL), so the paths are fixed.
  {
    path: '/invite/:token',
    name: 'invite',
    component: () => import('./pages/SetPasswordPage.vue'),
    props: { purpose: 'invite' },
    meta: { public: true, title: 'Join your household' },
  },
  {
    path: '/reset-password/:token',
    name: 'reset-password',
    component: () => import('./pages/SetPasswordPage.vue'),
    props: { purpose: 'reset' },
    meta: { public: true, title: 'Reset your password' },
  },
  {
    path: '/unavailable',
    name: 'unavailable',
    component: () => import('./pages/UnavailablePage.vue'),
    meta: { public: true, title: 'Cannot reach the server' },
  },
  {
    path: '/',
    component: () => import('./layouts/AppLayout.vue'),
    children: [
      {
        path: '',
        name: 'home',
        component: () => import('./pages/HomePage.vue'),
        meta: { title: 'Today' },
      },
      {
        path: 'upcoming',
        name: 'upcoming',
        component: () => import('./pages/UpcomingPage.vue'),
        meta: { title: 'Coming up' },
      },
      {
        path: 'tasks',
        name: 'tasks',
        component: () => import('./pages/TasksPage.vue'),
        meta: { title: 'All tasks' },
      },
      {
        path: 'tasks/new',
        name: 'task-new',
        component: () => import('./pages/TaskEditorPage.vue'),
        meta: { title: 'New task' },
      },
      {
        path: 'tasks/:id',
        name: 'task-edit',
        component: () => import('./pages/TaskEditorPage.vue'),
        props: true,
        meta: { title: 'Edit task' },
      },
      {
        path: 'people',
        name: 'people',
        component: () => import('./pages/MembersPage.vue'),
        meta: { title: 'People' },
      },
      {
        path: 'suggestions',
        name: 'suggestions',
        component: () => import('./pages/SuggestionsPage.vue'),
        meta: { title: 'Suggestions' },
      },
      {
        path: 'account',
        name: 'account',
        component: () => import('./pages/AccountPage.vue'),
        meta: { title: 'Account' },
      },
      // Inside the layout, and not public: logged-out visitors log in first, then see the 404.
      {
        path: ':rest(.*)*',
        name: 'not-found',
        component: () => import('./pages/NotFoundPage.vue'),
        meta: { title: 'Page not found' },
      },
    ],
  },
];

/** `?redirect=` is only followed when it is a path on this site (never `//host` or a URL). */
export function safeRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\')) return '/';
  return value;
}

/**
 * Router with the auth guards:
 *  - until the first member exists, everything goes to /setup (and /setup is only open then);
 *  - pages other than the public ones need a session, else /login?redirect=...;
 *  - /login is for logged-out visitors only;
 *  - when a new version of the app has taken over (see `registerServiceWorker`), the next
 *    navigation is a full page load of the target, so the new code and its lazily loaded chunks
 *    are used and nothing the member was doing on the current page is thrown away before then.
 * The session store must have a client registered (`setApi`) before the first navigation.
 */
export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  const router = createRouter({ history, routes });

  router.beforeEach(async (to): Promise<boolean | RouteLocationRaw> => {
    // Cancel the client-side navigation: the page is about to be replaced by the new version.
    if (loadPendingUpdate(to.fullPath)) return false;

    const session = useSessionStore();
    await session.bootstrap();

    if (session.bootError) return to.name === 'unavailable' ? true : { name: 'unavailable' };
    if (to.name === 'unavailable') return { name: 'home' };

    if (session.needsSetup && !session.isLoggedIn) {
      return to.name === 'setup' ? true : { name: 'setup' };
    }
    if (to.name === 'setup') {
      return session.isLoggedIn ? { name: 'home' } : { name: 'login' };
    }

    if (session.isLoggedIn) {
      return to.meta.guestOnly ? safeRedirect(to.query['redirect']) : true;
    }
    if (to.meta.public) return true;
    return {
      name: 'login',
      query: to.fullPath === '/' ? {} : { redirect: to.fullPath },
    };
  });

  router.afterEach((to) => {
    document.title = to.meta.title
      ? `${to.meta.title} · Intelligent Tracker`
      : 'Intelligent Tracker';
  });

  return router;
}
