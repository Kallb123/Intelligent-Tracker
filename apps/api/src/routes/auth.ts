import { member, session } from '@tracker/db';
import {
  changePasswordBodySchema,
  loginBodySchema,
  okSchema,
  sessionInfoSchema,
  type SessionInfo,
} from '@tracker/shared';
import { and, eq, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authOf } from '../auth/guards.js';
import { sessionInfo } from '../auth/payloads.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { clearSessionCookie, startSession } from '../auth/sessions.js';
import type { ApiContext } from '../context.js';
import { AppError, tooManyRequests, unauthorized } from '../errors.js';

/**
 * Sessions for existing members:
 *   POST /api/auth/login     public. Username or email + password, optional `remember` (30 days).
 *   POST /api/auth/logout    session. Deletes the server-side session.
 *   GET  /api/auth/me        session. Who am I, plus the CSRF token to send as `X-CSRF-Token`.
 *   POST /api/auth/password  session. Change own password (needs the current one); signs out
 *                            every other session.
 */
export function registerAuthRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { limiters } = ctx;

  r.post(
    '/api/auth/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Log in',
        body: loginBodySchema,
        response: { 200: sessionInfoSchema },
      },
    },
    async (request, reply): Promise<SessionInfo> => {
      const { identifier, password, remember } = request.body;
      const idKey = identifier.toLowerCase();
      const ipKey = request.ip;

      // Checked before the password, so a locked-out client learns nothing about guesses.
      const wait = Math.max(
        limiters.identifier.retryAfterMs(idKey),
        limiters.ip.retryAfterMs(ipKey),
      );
      if (wait > 0) throw tooManyRequests(wait);

      const [found] = await ctx.db
        .select()
        .from(member)
        .where(
          or(
            eq(sql`lower(${member.username})`, sql`lower(${identifier})`),
            eq(sql`lower(${member.email})`, sql`lower(${identifier})`),
          ),
        )
        .limit(1);

      // Unknown users and members who have not set a password yet still pay for one hash, and
      // fail with the same error, so neither timing nor the message reveals who exists.
      let valid = false;
      if (found?.passwordHash) valid = await verifyPassword(password, found.passwordHash);
      else await ctx.verifyDummy(password);

      if (!found || !valid) {
        limiters.identifier.recordFailure(idKey);
        limiters.ip.recordFailure(ipKey);
        throw unauthorized('Incorrect username or password');
      }

      limiters.identifier.reset(idKey);
      const { csrfToken } = await startSession(ctx, request, reply, found, remember);
      return sessionInfo(ctx, found, csrfToken);
    },
  );

  r.post(
    '/api/auth/logout',
    {
      onRequest: app.requireAuth,
      schema: { tags: ['Auth'], summary: 'Log out', response: { 200: okSchema } },
    },
    async (request, reply) => {
      await ctx.db.delete(session).where(eq(session.id, authOf(request).sessionId));
      clearSessionCookie(ctx, reply);
      return { ok: true as const };
    },
  );

  r.get(
    '/api/auth/me',
    {
      onRequest: app.requireAuth,
      schema: {
        tags: ['Auth'],
        summary: 'Get the current session',
        response: { 200: sessionInfoSchema },
      },
    },
    async (request) => {
      const { member: me, csrfToken } = authOf(request);
      return sessionInfo(ctx, me, csrfToken);
    },
  );

  r.post(
    '/api/auth/password',
    {
      onRequest: app.requireAuth,
      schema: {
        tags: ['Auth'],
        summary: 'Change your password',
        body: changePasswordBodySchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      const { member: me, sessionId } = authOf(request);
      const { currentPassword, newPassword } = request.body;

      // A stolen session must not be a free oracle for guessing the password.
      const wait = limiters.passwordChange.retryAfterMs(me.id);
      if (wait > 0) throw tooManyRequests(wait);
      const ok = me.passwordHash ? await verifyPassword(currentPassword, me.passwordHash) : false;
      if (!ok) {
        limiters.passwordChange.recordFailure(me.id);
        throw new AppError(400, 'wrong_password', 'Your current password is incorrect');
      }
      limiters.passwordChange.reset(me.id);

      const passwordHash = await hashPassword(newPassword, ctx.config.passwordParams);
      await ctx.db.transaction(async (tx) => {
        await tx.update(member).set({ passwordHash }).where(eq(member.id, me.id));
        await tx.delete(session).where(and(eq(session.memberId, me.id), ne(session.id, sessionId)));
      });
      return { ok: true as const };
    },
  );
}
