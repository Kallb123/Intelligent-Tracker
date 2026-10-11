import createClient, { type Middleware } from 'openapi-fetch';
import { apiErrorFromResponse, networkError } from './errors.js';
import type { paths } from './schema.js';

export type ApiClient = ReturnType<typeof createClient<paths>>;

export interface ApiClientOptions {
  /** Injectable so tests need no network. Looked up per call, so stubbing `fetch` later works. */
  fetch?: typeof fetch;
  /** The CSRF token of the current session, read on every mutating request. */
  getCsrfToken?: () => string | undefined;
  /** Called when a response is 401 (the session ended), before the ApiError is thrown. */
  onUnauthorized?: () => void;
  baseUrl?: string;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The typed API client (openapi-fetch over the generated `schema.d.ts`).
 *
 * - Mutating requests always carry `Content-Type: application/json` (the api refuses other body
 *   types, and accepts an empty body such as logout's) and, when logged in, `X-CSRF-Token`.
 * - Cookies go with same-origin requests only.
 * - Non-2xx responses throw an `ApiError` built from `{ error, message }`, and network failures
 *   throw an `ApiError` with status 0, so callers only deal with one error type.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const client = createClient<paths>({
    // Absolute even in the browser: `Request` needs an absolute URL outside one.
    baseUrl: options.baseUrl ?? globalThis.location?.origin ?? 'http://localhost',
    credentials: 'same-origin',
    fetch: (request) => (options.fetch ?? globalThis.fetch)(request),
  });

  const middleware: Middleware = {
    onRequest({ request }) {
      if (!MUTATING_METHODS.has(request.method)) return undefined;
      request.headers.set('Content-Type', 'application/json');
      const csrfToken = options.getCsrfToken?.();
      if (csrfToken) request.headers.set('X-CSRF-Token', csrfToken);
      return request;
    },
    async onResponse({ response }) {
      if (response.ok) return undefined;
      if (response.status === 401) options.onUnauthorized?.();
      throw await apiErrorFromResponse(response);
    },
    onError() {
      return networkError();
    },
  };
  client.use(middleware);
  return client;
}
