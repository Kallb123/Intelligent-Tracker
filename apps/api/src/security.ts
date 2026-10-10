import type { FastifyInstance } from 'fastify';
import type { AuthConfig } from './config.js';
import { forbidden } from './errors.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Request-level protections that apply to every route, including the pre-login ones
 * (setup, login, accept invite) that have no session to hang a CSRF token on:
 *
 * 1. Origin check: a mutating request whose `Origin` header names another site is refused.
 *    Browsers always send `Origin` on cross-site POSTs; requests without it (curl, the Telegram
 *    bot, tests) are not browser-driven, so they cannot be cross-site forgeries.
 * 2. Bodies must be JSON. Cross-site forms can only send urlencoded, multipart or text/plain
 *    without a CORS preflight, so refusing those (415) closes the "simple request" loophole.
 *    An empty body is allowed so bodiless POSTs like logout work with a JSON content type.
 */
export function registerSecurity(app: FastifyInstance, config: AuthConfig): void {
  const configuredHost = config.publicBaseUrl ? new URL(config.publicBaseUrl).host : undefined;

  app.addHook('onRequest', async (request) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (origin === undefined) return;

    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      // "null" (sandboxed frames, some redirects) and garbage are never our own origin.
    }
    const allowed = [request.headers.host, request.host, configuredHost];
    if (originHost === undefined || !allowed.includes(originHost)) {
      throw forbidden('Cross-origin request refused');
    }
  });

  app.removeContentTypeParser('text/plain');
  app.removeContentTypeParser('application/json');
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (body === '') return done(null, undefined);
    parseJson(request, body as string, done);
  });
}
