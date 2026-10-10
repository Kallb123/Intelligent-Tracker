import { linkInfoSchema, sessionInfoSchema, setPasswordBodySchema } from '@tracker/shared';
import { eq } from 'drizzle-orm';
import { member } from '@tracker/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sessionInfo } from '../auth/payloads.js';
import { hashPassword } from '../auth/passwords.js';
import {
  lookupPasswordToken,
  redeemPasswordToken,
  type PasswordTokenPurpose,
} from '../auth/password-tokens.js';
import { startSession } from '../auth/sessions.js';
import type { ApiContext } from '../context.js';
import { one } from '../rows.js';

/**
 * Public, one-time links that let a member choose a password. Both kinds work the same way and
 * log the member in on success; the token in the path is the only credential.
 *   GET  /api/invites/:token           who the invite is for (for the accept page)
 *   POST /api/invites/:token/accept    set a password for a newly invited member
 *   GET  /api/password-resets/:token   who the reset link is for
 *   POST /api/password-resets/:token   set a new password after an admin reset
 * A used or expired link answers 410, an unknown one 404.
 */
export function registerLinkRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ token: z.string().min(1).max(200) });
  const tags = ['Links'];

  function register(purpose: PasswordTokenPurpose, infoPath: string, redeemPath: string): void {
    r.get(
      infoPath,
      {
        schema: {
          tags,
          summary: `Look up a ${purpose} link`,
          params,
          response: { 200: linkInfoSchema },
        },
      },
      async (request) => {
        const target = await lookupPasswordToken(ctx, request.params.token, purpose);
        return {
          name: target.name,
          username: target.username,
          householdName: target.householdName,
          expiresAt: target.expiresAt.toISOString(),
        };
      },
    );

    r.post(
      redeemPath,
      {
        schema: {
          tags,
          summary: `Use a ${purpose} link to set a password`,
          params,
          body: setPasswordBodySchema,
          response: { 200: sessionInfoSchema },
        },
      },
      async (request, reply) => {
        // Validate the link before spending a password hash on it.
        const target = await lookupPasswordToken(ctx, request.params.token, purpose);
        const passwordHash = await hashPassword(request.body.password, ctx.config.passwordParams);
        await redeemPasswordToken(ctx, target, passwordHash);

        const m = one(await ctx.db.select().from(member).where(eq(member.id, target.memberId)));
        const { csrfToken } = await startSession(ctx, request, reply, m, request.body.remember);
        return sessionInfo(ctx, m, csrfToken);
      },
    );
  }

  register('invite', '/api/invites/:token', '/api/invites/:token/accept');
  register('reset', '/api/password-resets/:token', '/api/password-resets/:token');
}
