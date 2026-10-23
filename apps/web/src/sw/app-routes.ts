/**
 * Which page loads the service worker answers with the cached app shell, kept apart from `sw.ts`
 * (which needs a service worker to run) so it can be unit tested.
 */

/** The backend's paths: `/api/*` and `/ical/*` are never the app. */
const BACKEND_PATH = /^\/(api|ical)(\/|$)/;

/** The last path segment has an extension, so the request is for a file, not a page. */
const FILE_PATH = /\/[^/]+\.[^/]+$/;

/**
 * Whether a page load for `pathname` is answered with the app shell: any path of the app, but
 * not the backend and not a file such as `/manifest.webmanifest`. Only the path is looked at: a
 * query string or hash can contain anything (`/tasks?next=/a.b` is still the Tasks page).
 */
export function isAppPagePath(pathname: string): boolean {
  return !BACKEND_PATH.test(pathname) && !FILE_PATH.test(pathname);
}
