import { pushSubscription } from '@tracker/db';
import {
  pushConfigSchema,
  pushSubscriptionBodySchema,
  pushUnsubscribeBodySchema,
} from '@tracker/shared';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authOf } from '../auth/guards.js';
import type { ApiContext } from '../context.js';
import { AppError, errorResponseSchema } from '../errors.js';

/** The most browsers one member can have subscribed; the least recently updated go first. */
export const MAX_SUBSCRIPTIONS_PER_MEMBER = 20;

/**
 * Web Push: the browser's side of PWA notifications. All need a session; the
 * worker does the sending. A member only ever sees and changes their own subscriptions.
 *   GET    /api/push/config          the VAPID public key to subscribe with (null when push is off)
 *   POST   /api/push/subscriptions   register (or refresh) this browser's subscription
 *   DELETE /api/push/subscriptions   remove this browser's subscription
 */
export function registerPushRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['Push'];
  const publicKey = ctx.config.vapidPublicKey ?? null;

  r.get(
    '/api/push/config',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Web Push settings',
        description:
          '`publicKey` is the VAPID public key to pass to `PushManager.subscribe` as the ' +
          'application server key. It is null when the deployment has not configured push, in ' +
          'which case the web app does not offer it.',
        response: { 200: pushConfigSchema, 401: errorResponseSchema },
      },
    },
    async () => ({ publicKey }),
  );

  r.post(
    '/api/push/subscriptions',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Save my push subscription',
        description:
          'Takes `PushSubscription.toJSON()`. Saving the same endpoint again refreshes its keys, ' +
          'and an endpoint that another member had saved (a shared device) moves to the caller. ' +
          'A member keeps at most 20 subscriptions: saving more drops the least recently saved. ' +
          'Answers 409 `push_not_configured` when the deployment has no VAPID keys.',
        body: pushSubscriptionBodySchema,
        response: {
          204: z.null().describe('Saved'),
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (publicKey === null) {
        throw new AppError(
          409,
          'push_not_configured',
          'Push notifications are not set up on this server',
        );
      }
      const me = authOf(request).member;
      const { endpoint, keys } = request.body;
      const now = ctx.config.clock();
      const values = {
        memberId: me.id,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: request.headers['user-agent']?.slice(0, 255) ?? null,
        // Set by hand (`$onUpdate` does not apply to an upsert) from the configured clock.
        updatedAt: now,
      };
      await ctx.db
        .insert(pushSubscription)
        .values({ endpoint, ...values, createdAt: now })
        .onConflictDoUpdate({ target: pushSubscription.endpoint, set: values });

      const newest = await ctx.db
        .select({ id: pushSubscription.id })
        .from(pushSubscription)
        .where(eq(pushSubscription.memberId, me.id))
        .orderBy(desc(pushSubscription.updatedAt), desc(pushSubscription.id))
        .limit(MAX_SUBSCRIPTIONS_PER_MEMBER);
      if (newest.length === MAX_SUBSCRIPTIONS_PER_MEMBER) {
        await ctx.db.delete(pushSubscription).where(
          and(
            eq(pushSubscription.memberId, me.id),
            notInArray(
              pushSubscription.id,
              newest.map((row) => row.id),
            ),
          ),
        );
      }
      return reply.code(204).send(null);
    },
  );

  r.delete(
    '/api/push/subscriptions',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Remove my push subscription',
        description:
          "Removes the caller's own subscription with this endpoint. Another member's " +
          'subscription is never touched, and one that is already gone is not an error.',
        body: pushUnsubscribeBodySchema,
        response: {
          204: z.null().describe('Removed, or there was none'),
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const me = authOf(request).member;
      await ctx.db
        .delete(pushSubscription)
        .where(
          and(
            eq(pushSubscription.memberId, me.id),
            eq(pushSubscription.endpoint, request.body.endpoint),
          ),
        );
      return reply.code(204).send(null);
    },
  );
}
