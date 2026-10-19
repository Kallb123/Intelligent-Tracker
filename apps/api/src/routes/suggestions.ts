import { listSuggestions, resolveSuggestion } from '@tracker/db';
import {
  suggestionActionSchema,
  suggestionIdSchema,
  suggestionsResponseSchema,
} from '@tracker/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authOf } from '../auth/guards.js';
import type { ApiContext } from '../context.js';
import { conflict, errorResponseSchema } from '../errors.js';

export function registerSuggestionRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['Suggestions'];
  r.get(
    '/api/suggestions',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'List history-based suggestions',
        response: {
          200: suggestionsResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request) => ({
      suggestions: await listSuggestions(
        ctx.db,
        authOf(request).member.householdId,
        ctx.config.clock(),
      ),
    }),
  );
  r.post(
    '/api/suggestions/:id',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Accept or dismiss a history-based suggestion',
        params: z.object({ id: suggestionIdSchema }),
        body: suggestionActionSchema,
        response: {
          204: z.null(),
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const me = authOf(request).member;
      const changed = await resolveSuggestion(ctx.db, {
        householdId: me.householdId,
        memberId: me.id,
        id: request.params.id,
        action: request.body.action,
        now: ctx.config.clock(),
      });
      if (!changed)
        throw conflict('suggestion_stale', 'This suggestion is out of date. Refresh the inbox.');
      return reply.code(204).send(null);
    },
  );
}
