import {
  household,
  issueGroupLinkCode,
  issueMemberLinkCode,
  setTelegramNotifications,
  unlinkGroup,
  unlinkMember,
  one,
} from '@tracker/db';
import {
  groupLinkResponseSchema,
  memberLinkResponseSchema,
  telegramNotificationsFromDisabled,
  telegramNotificationsPatchSchema,
  telegramNotificationsSchema,
  telegramStatusSchema,
} from '@tracker/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authOf } from '../auth/guards.js';
import type { ApiContext } from '../context.js';
import { errorResponseSchema } from '../errors.js';

/**
 * Linking Telegram to the app (docs/PLAN.md 5.1). All need a session; the group ones need an
 * admin. A code is only ever returned here, once: just its hash is stored, and the bot redeems it.
 *   GET    /api/telegram              the bot's username, and whether the group and the caller are linked, and which kinds of message the group is sent
 *   POST   /api/telegram/link         a one-time code (and `t.me` deep link) linking the caller's account
 *   DELETE /api/telegram/link         unlink the caller's account
 *   POST   /api/telegram/group-link   a one-time code for `/linkgroup` in the house group (admin)
 *   DELETE /api/telegram/group-link   unlink the house group (admin)
 *   PATCH  /api/telegram/notifications  switch kinds of house-group message on or off (admin)
 */
export function registerTelegramRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['Telegram'];
  const botUsername = ctx.config.telegramBotUsername ?? null;

  r.get(
    '/api/telegram',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Telegram link status',
        description:
          '`botUsername` is null when the deployment has not configured it, in which case the ' +
          'web app shows the code to send to the bot instead of a link.',
        response: { 200: telegramStatusSchema, 401: errorResponseSchema },
      },
    },
    async (request) => {
      const me = authOf(request).member;
      const h = one(
        await ctx.db
          .select({
            chatId: household.telegramGroupChatId,
            disabled: household.telegramDisabledNotifications,
          })
          .from(household)
          .where(eq(household.id, me.householdId)),
      );
      return {
        botUsername,
        groupLinked: h.chatId !== null,
        memberLinked: me.telegramUserId !== null,
        notifications: telegramNotificationsFromDisabled(h.disabled),
      };
    },
  );

  r.post(
    '/api/telegram/link',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Get a code to connect my Telegram account',
        description:
          'Valid for an hour and replaces any earlier code. Opening `url` starts a chat with ' +
          'the bot that links the account; without a configured bot username, send `/start ' +
          '<code>` to the bot instead.',
        response: { 200: memberLinkResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) => {
      const me = authOf(request).member;
      const { code, expiresAt } = await issueMemberLinkCode(ctx.db, me.id, {
        now: ctx.config.clock(),
      });
      return {
        code,
        expiresAt: expiresAt.toISOString(),
        url: botUsername
          ? `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(code)}`
          : null,
      };
    },
  );

  r.delete(
    '/api/telegram/link',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Disconnect my Telegram account',
        description: 'Also cancels a code that has not been used yet.',
        response: {
          204: z.null().describe('Disconnected'),
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await unlinkMember(ctx.db, authOf(request).member.id);
      return reply.code(204).send(null);
    },
  );

  r.post(
    '/api/telegram/group-link',
    {
      onRequest: app.requireAdmin,
      schema: {
        tags,
        summary: 'Get a code to link the house group (admin)',
        description:
          'Valid for an hour and replaces any earlier code. An admin adds the bot to the house ' +
          'group and sends `command` there.',
        response: {
          200: groupLinkResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const { code, expiresAt } = await issueGroupLinkCode(
        ctx.db,
        authOf(request).member.householdId,
        { now: ctx.config.clock() },
      );
      return { code, expiresAt: expiresAt.toISOString(), command: `/linkgroup ${code}` };
    },
  );

  r.delete(
    '/api/telegram/group-link',
    {
      onRequest: app.requireAdmin,
      schema: {
        tags,
        summary: 'Unlink the house group (admin)',
        description: 'Also cancels a code that has not been used yet.',
        response: {
          204: z.null().describe('Unlinked'),
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await unlinkGroup(ctx.db, authOf(request).member.householdId);
      return reply.code(204).send(null);
    },
  );

  r.patch(
    '/api/telegram/notifications',
    {
      onRequest: app.requireAdmin,
      schema: {
        tags,
        summary: 'Switch house-group notifications on or off (admin)',
        description:
          'Only the types in the body change; the rest keep their setting. Applies to what the ' +
          'bot posts in the house group on its own (each reminder kind and the digests), not to ' +
          'in-app notifications, Web Push or the bot commands. Returns every switch afterwards.',
        body: telegramNotificationsPatchSchema,
        response: {
          200: z.object({ notifications: telegramNotificationsSchema }),
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const notifications = await setTelegramNotifications(
        ctx.db,
        authOf(request).member.householdId,
        request.body,
      );
      // The caller's household exists (they have a session in it), so null cannot happen.
      if (!notifications) throw new Error('The signed-in member has no household');
      return { notifications };
    },
  );
}
