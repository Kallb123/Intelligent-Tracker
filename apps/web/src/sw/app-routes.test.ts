import { describe, expect, it } from 'vitest';
import { isAppPagePath } from './app-routes.js';

describe('isAppPagePath', () => {
  it.each([
    '/',
    '/tasks',
    '/tasks/new',
    '/tasks/abc-123',
    '/invite/abc',
    '/a.b/c',
    '/apis',
    '/icalendar',
  ])('serves the app shell for the page %s', (pathname) => {
    expect(isAppPagePath(pathname)).toBe(true);
  });

  it.each(['/api', '/api/tasks', '/api/auth/me', '/ical', '/ical/feed.ics', '/ical/token/x'])(
    'leaves the backend path %s to the network',
    (pathname) => {
      expect(isAppPagePath(pathname)).toBe(false);
    },
  );

  it.each([
    '/manifest.webmanifest',
    '/sw.js',
    '/icon-192.png',
    '/assets/index-abc123.js',
    '/tasks/export.csv',
  ])('leaves the file %s to the network', (pathname) => {
    expect(isAppPagePath(pathname)).toBe(false);
  });

  it('looks at the path only, not the query string or hash', () => {
    // What the service worker passes is `url.pathname`, so these are the pages they came from:
    // `/tasks?next=/a.b` and `/login?redirect=/export.csv#top`.
    for (const url of ['/tasks?next=/a.b', '/login?redirect=/export.csv#top', '/people#a.b']) {
      expect(isAppPagePath(new URL(url, 'https://tracker.example').pathname), url).toBe(true);
    }
    // A file is still a file with a query string.
    expect(isAppPagePath(new URL('/sw.js?v=2', 'https://tracker.example').pathname)).toBe(false);
  });
});
