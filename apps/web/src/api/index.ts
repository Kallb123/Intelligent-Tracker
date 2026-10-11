import type { ApiClient } from './client.js';

export { ApiError, describeError } from './errors.js';
export { createApiClient, type ApiClient, type ApiClientOptions } from './client.js';

let current: ApiClient | undefined;

/**
 * The app-wide client. `main.ts` registers the real one (wired to the session store); tests
 * register one with a fake `fetch`. Keeping it out of the stores' imports avoids a cycle.
 */
export function setApi(client: ApiClient | undefined): void {
  current = client;
}

export function getApi(): ApiClient {
  if (!current) throw new Error('API client not configured: call setApi() first');
  return current;
}
