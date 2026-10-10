import { session, type Member } from '@tracker/db';
import { lt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiContext } from '../context.js';
import { csrfTokenFor, generateToken, hashToken } from './tokens.js';

/** The `__Host-` prefix makes browsers refuse the cookie unless it is Secure, Path=/ and host-only. */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-session' : 'session';
}

export interface StartedSession {
  csrfToken: string;
}

/**
 * Creates a server-side session for `member` and sets its cookie. The cookie holds a random
 * token; only its SHA-256 hash is stored as the session id. With `remember` the session (and
 * cookie) last 30 days, otherwise a day on the server and the cookie ends with the browser session.
 */
export async function startSession(
  ctx: ApiContext,
  request: FastifyRequest,
  reply: FastifyReply,
  member: Pick<Member, 'id'>,
  remember: boolean | undefined,
): Promise<StartedSession> {
  const { config, db } = ctx;
  const now = config.clock();
  const ttlMs = remember ? config.rememberTtlMs : config.sessionTtlMs;
  const token = generateToken();

  // Housekeeping: expired sessions are useless, so clear them out whenever someone logs in.
  await db.delete(session).where(lt(session.expiresAt, now));
  await db.insert(session).values({
    id: hashToken(token),
    memberId: member.id,
    expiresAt: new Date(now.getTime() + ttlMs),
    userAgent: request.headers['user-agent']?.slice(0, 255) ?? null,
  });

  reply.setCookie(sessionCookieName(config.cookieSecure), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    ...(remember ? { maxAge: Math.floor(ttlMs / 1000) } : {}),
  });
  return { csrfToken: csrfTokenFor(token) };
}

export function clearSessionCookie(ctx: ApiContext, reply: FastifyReply): void {
  reply.clearCookie(sessionCookieName(ctx.config.cookieSecure), {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.cookieSecure,
    path: '/',
  });
}
