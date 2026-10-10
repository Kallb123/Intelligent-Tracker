import { member, session, type Member } from '@tracker/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiContext } from '../context.js';
import { forbidden, unauthorized } from '../errors.js';
import { clearSessionCookie, sessionCookieName } from './sessions.js';
import { csrfTokenFor, hashToken, safeEqual } from './tokens.js';

/** Who a request is logged in as; set by `requireAuth`. */
export interface AuthContext {
  member: Member;
  /** `session.id` (the token hash) of the current session. */
  sessionId: string;
  csrfToken: string;
}

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    /** `onRequest` hook: 401 without a valid session, 403 on a mutating request without CSRF token. */
    requireAuth: Guard;
    /** Like `requireAuth`, plus 403 unless the member is an admin. */
    requireAdmin: Guard;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-csrf-token';

/** Returns the request's auth context; only valid on routes guarded by `requireAuth`. */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

/**
 * Adds `requireAuth` / `requireAdmin` and the `request.auth` slot.
 *
 * CSRF: every non-safe request on a session must carry `X-CSRF-Token` equal to the HMAC derived
 * from that session's cookie token (`csrfTokenFor`). SameSite=Lax cookies already stop most
 * cross-site posts; the token covers the rest. The api hands it out in the login/setup/`me` bodies.
 */
export function registerGuards(app: FastifyInstance, ctx: ApiContext): void {
  const cookieName = sessionCookieName(ctx.config.cookieSecure);
  app.decorateRequest('auth', null);

  const requireAuth: Guard = async (request, reply) => {
    const token = request.cookies[cookieName];
    if (!token) throw unauthorized();

    const sessionId = hashToken(token);
    const [row] = await ctx.db
      .select({ session, member })
      .from(session)
      .innerJoin(member, eq(member.id, session.memberId))
      .where(eq(session.id, sessionId))
      .limit(1);

    if (!row || row.session.expiresAt <= ctx.config.clock()) {
      if (row) await ctx.db.delete(session).where(eq(session.id, sessionId));
      // The cookie is dead; drop it so the browser stops sending it.
      clearSessionCookie(ctx, reply);
      throw unauthorized();
    }

    const csrfToken = csrfTokenFor(token);
    if (!SAFE_METHODS.has(request.method)) {
      const sent = request.headers[CSRF_HEADER];
      if (typeof sent !== 'string' || !safeEqual(sent, csrfToken)) {
        throw forbidden('Missing or invalid CSRF token');
      }
    }
    request.auth = { member: row.member, sessionId, csrfToken };
  };

  app.decorate('requireAuth', requireAuth);
  app.decorate('requireAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (authOf(request).member.role !== 'admin') throw forbidden('Only admins can do that');
  });
}
