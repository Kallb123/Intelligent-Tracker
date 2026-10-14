import { notification } from '@tracker/db';
import {
  notificationListQuerySchema,
  notificationsResponseSchema,
  type NotificationDto,
} from '@tracker/shared';
import { and, count, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authOf } from '../auth/guards.js';
import type { ApiContext } from '../context.js';
import { errorResponseSchema, notFound } from '../errors.js';

/** The caller's in-app notifications that the worker has delivered (stamped `sent_at`). */
const ownSent = (memberId: string) =>
  and(
    eq(notification.memberId, memberId),
    eq(notification.channel, 'in_app'),
    isNotNull(notification.sentAt),
  );

/**
 * The bell: a member's own in-app notifications (outbox rows on the `in_app` channel). Both need
 * a session; nobody can see or change another member's notifications, which answer 404:
 *   GET  /api/notifications?limit=        newest first, with the number of unread ones
 *   POST /api/notifications/:id/read      mark one read (again is fine)
 *   POST /api/notifications/read-all     mark all read
 */
export function registerNotificationRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['Notifications'];

  r.get(
    '/api/notifications',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'List my notifications',
        description:
          'The newest in-app notifications for the logged-in member, newest first. ' +
          '`unreadCount` counts every unread one, not only those returned.',
        querystring: notificationListQuerySchema,
        response: { 200: notificationsResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) => {
      const me = authOf(request).member;
      const [rows, [unread]] = await Promise.all([
        ctx.db
          .select({
            id: notification.id,
            createdAt: notification.createdAt,
            readAt: notification.readAt,
            payload: notification.payload,
          })
          .from(notification)
          .where(ownSent(me.id))
          .orderBy(desc(notification.createdAt), desc(notification.id))
          .limit(request.query.limit),
        ctx.db
          .select({ n: count() })
          .from(notification)
          .where(and(ownSent(me.id), isNull(notification.readAt))),
      ]);
      const items: NotificationDto[] = rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        readAt: row.readAt?.toISOString() ?? null,
        payload: row.payload,
      }));
      return { items, unreadCount: unread?.n ?? 0 };
    },
  );

  r.post(
    '/api/notifications/read-all',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Mark all my notifications read',
        response: {
          204: z.null().describe('Marked read'),
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const me = authOf(request).member;
      await ctx.db
        .update(notification)
        .set({ readAt: ctx.config.clock() })
        .where(and(ownSent(me.id), isNull(notification.readAt)));
      return reply.code(204).send(null);
    },
  );

  r.post(
    '/api/notifications/:id/read',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Mark a notification read',
        description: 'Marking one that is already read changes nothing.',
        params: z.object({ id: z.uuid() }),
        response: {
          204: z.null().describe('Marked read'),
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const me = authOf(request).member;
      const updated = await ctx.db
        .update(notification)
        // Keeps the first read time when it is read again.
        .set({
          readAt: sql`coalesce(${notification.readAt}, ${ctx.config.clock().toISOString()}::timestamptz)`,
        })
        .where(and(eq(notification.id, request.params.id), ownSent(me.id)))
        .returning({ id: notification.id });
      if (updated.length === 0) throw notFound('No such notification');
      return reply.code(204).send(null);
    },
  );
}
