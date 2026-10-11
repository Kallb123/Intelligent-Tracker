/**
 * A failed API call. The api answers every error with `{ error, message }`, so pages can show
 * `message` as is and branch on `status` / `code` (for example 410 for a used invite link).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds to wait before retrying, from a 429's `Retry-After` header. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Status 0 means the request never got an answer (offline, server down, proxy error). */
export const NETWORK_ERROR_CODE = 'network_error';

export function networkError(): ApiError {
  return new ApiError(
    0,
    NETWORK_ERROR_CODE,
    'Could not reach the server. Check your connection and try again.',
  );
}

function isErrorBody(body: unknown): body is { error: string; message: string } {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    'message' in body &&
    typeof body.error === 'string' &&
    typeof body.message === 'string'
  );
}

/** Builds an ApiError from a non-2xx response, tolerating bodies that are not our JSON shape. */
export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    // A proxy's HTML error page, an empty body, ...
  }
  const retryHeader = Number(response.headers.get('retry-after'));
  const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined;
  if (isErrorBody(body)) {
    return new ApiError(response.status, body.error, body.message, retryAfter);
  }
  return new ApiError(
    response.status,
    'http_error',
    `The server returned an unexpected error (${response.status}).`,
    retryAfter,
  );
}

/** How long to wait, in words, for a Retry-After of this many seconds. */
function describeWait(seconds: number): string {
  if (seconds <= 60) return `${Math.ceil(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minutes`;
}

/** A user-facing message, adding the wait time for rate-limited requests. */
export function describeError(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Something went wrong. Please try again.';
  if (err.status === 429 && err.retryAfter !== undefined) {
    return `${err.message} Try again in ${describeWait(err.retryAfter)}.`;
  }
  return err.message;
}
