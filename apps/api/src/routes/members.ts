import { listMembers, member, one, session, setMemberAway } from '@tracker/db';
import {
  createInviteBodySchema,
  createInviteResponseSchema,
  membersResponseSchema,
  passwordResetResponseSchema,
  setAwayBodySchema,
  memberResponseSchema,
} from '@tracker/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authOf } from '../auth/guards.js';
import { toMemberDto } from '../auth/payloads.js';
import {
  issuePasswordToken,
  type IssuedLink,
  type PasswordTokenPurpose,
} from '../auth/password-tokens.js';
import type { ApiContext } from '../context.js';
import { uniqueViolation } from '../db-errors.js';
import { AppError, conflict, errorResponseSchema, forbidden, notFound } from '../errors.js';

/**
 * Household members and the admin actions on them (all need a session; the admin ones need an
 * admin, and only ever touch the admin's own household):
 *   GET  /api/members                      list members (any member)
 *   PATCH /api/members/:id/away            set or clear when a member is away until (the member
 *                                          themselves, or an admin); re-plans their rotations
 *   POST /api/invites                      create a member without a password and get a one-time
 *                                          invite link (admin)
 *   POST /api/members/:id/password-reset   get a one-time link to set a new password, and end the
 *                                          member's sessions; for a member who never accepted
 *                                          their invite this issues a fresh invite instead (admin)
 * The link's token is only ever returned here, once: just its hash is stored.
 */
export function registerMemberRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const linkDto = (link: IssuedLink) => ({
    token: link.token,
    url: link.url,
    expiresAt: link.expiresAt.toISOString(),
  });

  r.get(
    '/api/members',
    {
      onRequest: app.requireAuth,
      schema: {
        tags: ['Members'],
        summary: 'List household members',
        response: { 200: membersResponseSchema },
      },
    },
    async (request) => {
      const rows = await listMembers(ctx.db, authOf(request).member.householdId);
      return { members: rows.map(toMemberDto) };
    },
  );

  r.patch(
    '/api/members/:id/away',
    {
      onRequest: app.requireAuth,
      schema: {
        tags: ['Members'],
        summary: 'Set when a member is away until',
        description:
          'Rotating tasks skip the member for dues up to and including `awayUntil` (a ' +
          'household-local date); `null` clears it. Members set their own, admins anyone in the ' +
          "household. Open occurrences of the member's rotations are re-planned straight away.",
        params: z.object({ id: z.uuid() }),
        body: setAwayBodySchema,
        response: {
          200: memberResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const me = authOf(request).member;
      const now = ctx.config.clock();
      if (request.params.id !== me.id && me.role !== 'admin') {
        throw forbidden('You can only set your own away dates');
      }
      const result = await ctx.db.transaction((tx) =>
        setMemberAway(tx, {
          householdId: me.householdId,
          actorId: me.id,
          memberId: request.params.id,
          awayUntil: request.body.awayUntil,
          now,
        }),
      );
      if (!result) throw notFound('No such member');
      return { member: toMemberDto(result) };
    },
  );

  r.post(
    '/api/invites',
    {
      onRequest: app.requireAdmin,
      schema: {
        tags: ['Members'],
        summary: 'Invite a member (admin)',
        body: createInviteBodySchema,
        response: { 201: createInviteResponseSchema },
      },
    },
    async (request, reply) => {
      const admin = authOf(request).member;
      const body = request.body;

      // The member row is created now (no password, so it cannot log in), which reserves the
      // username/email and lets the members list show the pending invite.
      try {
        const result = await ctx.db.transaction(async (tx) => {
          const invited = one(
            await tx
              .insert(member)
              .values({
                householdId: admin.householdId,
                name: body.name,
                username: body.username,
                email: body.email ?? null,
                role: body.role,
              })
              .returning(),
          );
          const link = await issuePasswordToken(ctx, request, tx, {
            memberId: invited.id,
            purpose: 'invite',
            createdBy: admin.id,
          });
          return { invited, link };
        });
        return reply
          .code(201)
          .send({ member: toMemberDto(result.invited), invite: linkDto(result.link) });
      } catch (err) {
        const constraint = uniqueViolation(err);
        if (constraint === undefined) throw err;
        throw constraint.includes('email')
          ? conflict('email_taken', 'Another member already uses that email')
          : conflict('username_taken', 'That username is already taken');
      }
    },
  );

  r.post(
    '/api/members/:id/password-reset',
    {
      onRequest: app.requireAdmin,
      schema: {
        tags: ['Members'],
        summary: 'Start a password reset for a member (admin)',
        params: z.object({ id: z.uuid() }),
        response: { 200: passwordResetResponseSchema },
      },
    },
    async (request) => {
      const admin = authOf(request).member;
      if (request.params.id === admin.id) {
        throw new AppError(
          400,
          'use_change_password',
          'Change your own password from your account',
        );
      }
      const [target] = await ctx.db
        .select()
        .from(member)
        .where(and(eq(member.id, request.params.id), eq(member.householdId, admin.householdId)));
      if (!target) throw notFound('No such member');

      const purpose: PasswordTokenPurpose = target.passwordHash ? 'reset' : 'invite';
      const link = await ctx.db.transaction(async (tx) => {
        // Ending the sessions now (and again when the link is used) means a reset started
        // because an account may be compromised takes effect immediately.
        await tx.delete(session).where(eq(session.memberId, target.id));
        return issuePasswordToken(ctx, request, tx, {
          memberId: target.id,
          purpose,
          createdBy: admin.id,
        });
      });
      return { purpose, link: linkDto(link) };
    },
  );
}
