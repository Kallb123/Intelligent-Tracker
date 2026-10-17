import {
  applyOccurrenceAction,
  listableOccurrences,
  occurrence,
  OccurrenceActionError,
  viewCondition,
  viewOrder,
  type OccurrenceAction,
} from '@tracker/db';
import {
  MS_PER_DAY,
  occurrenceCompletionResponseSchema,
  occurrenceListQuerySchema,
  occurrenceResponseSchema,
  occurrencesResponseSchema,
  snoozeBodySchema,
  type OccurrenceDto,
} from '@tracker/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authOf } from '../auth/guards.js';
import type { ApiContext } from '../context.js';
import { AppError, conflict, errorResponseSchema, notFound } from '../errors.js';
import {
  householdSettings,
  loadOccurrenceDtos,
  type OverdueClock,
  selectOccurrences,
  toOccurrenceDto,
} from '../tasks/payloads.js';

/**
 * Occurrences (the concrete, dated instances of tasks) and what members do with them. All need a
 * session; every member can act on every occurrence in their own household, and anything in
 * another household is a 404:
 *   GET  /api/occurrences?view=today|upcoming|overdue&memberId=&taskId=&days=&limit=
 *   GET  /api/occurrences/:id
 *   POST /api/occurrences/:id/complete   done; may create the next occurrence (after_completion)
 *   POST /api/occurrences/:id/skip       like complete, but counts as skipped
 *   POST /api/occurrences/:id/snooze     hide until a time, or for a number of days
 *   POST /api/occurrences/:id/start      mark as started
 * Open means upcoming, active or started. Changing a closed (done/skipped) occurrence is 409.
 * Starting, completing or skipping an occurrence that was not yet started uses up its assignee's
 * turn in the task's rotation (see `consumeRotationTurn`).
 */
export function registerOccurrenceRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ id: z.uuid() });
  const tags = ['Occurrences'];
  const actionErrors = {
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
  };

  /**
   * Applies `action` to the household's occurrence (see `applyOccurrenceAction`) and returns it
   * as a DTO, with the ids of the occurrences it created.
   */
  async function actOnOccurrence(
    me: { householdId: string; id: string },
    occurrenceId: string,
    action: OccurrenceAction,
    now: Date,
  ): Promise<{ dto: OccurrenceDto; createdIds: string[]; clock: OverdueClock }> {
    const clock = { now, timezone: (await householdSettings(ctx.db, me.householdId)).timezone };
    let createdIds: string[];
    try {
      ({ createdIds } = await applyOccurrenceAction(ctx.db, {
        householdId: me.householdId,
        memberId: me.id,
        occurrenceId,
        now,
        action,
      }));
    } catch (error) {
      if (!(error instanceof OccurrenceActionError)) throw error;
      if (error.code === 'not_found') throw notFound('No such occurrence');
      throw conflict('occurrence_closed', error.message);
    }
    const [dto] = await loadOccurrenceDtos(ctx.db, me.householdId, [occurrenceId], clock);
    if (!dto) throw notFound('No such occurrence');
    return { dto, createdIds, clock };
  }

  /** Complete or skip: closes the occurrence and lets the schedule produce the next one. */
  function registerClose(action: 'complete' | 'skip', summary: string, description: string): void {
    r.post(
      `/api/occurrences/:id/${action}`,
      {
        onRequest: app.requireAuth,
        schema: {
          tags,
          summary,
          description,
          params,
          response: { 200: occurrenceCompletionResponseSchema, ...actionErrors },
        },
      },
      async (request) => {
        const me = authOf(request).member;
        const now = ctx.config.clock();
        const result = await actOnOccurrence(me, request.params.id, { type: action }, now);
        const [next] = await loadOccurrenceDtos(
          ctx.db,
          me.householdId,
          result.createdIds.slice(0, 1),
          result.clock,
        );
        return { occurrence: result.dto, next: next ?? null };
      },
    );
  }

  registerClose(
    'complete',
    'Complete an occurrence',
    'Marks an open occurrence done. For an `after_completion` task the next occurrence is ' +
      'created straight away and returned as `next`.',
  );
  registerClose(
    'skip',
    'Skip an occurrence',
    'Like completing, but recorded as skipped. An `after_completion` task still moves on to its next occurrence.',
  );

  r.post(
    '/api/occurrences/:id/snooze',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Snooze an occurrence',
        description:
          'Hides an open occurrence from the today and overdue views until `until` (which must ' +
          'be in the future) or for `days` days.',
        params,
        body: snoozeBodySchema,
        response: { 200: occurrenceResponseSchema, 400: errorResponseSchema, ...actionErrors },
      },
    },
    async (request) => {
      const me = authOf(request).member;
      const now = ctx.config.clock();
      const body = request.body;
      const until =
        'until' in body ? new Date(body.until) : new Date(now.getTime() + body.days * MS_PER_DAY);
      if (until <= now)
        throw new AppError(400, 'invalid_snooze', 'Snooze until a time in the future');

      const { dto } = await actOnOccurrence(me, request.params.id, { type: 'snooze', until }, now);
      return { occurrence: dto };
    },
  );

  r.post(
    '/api/occurrences/:id/start',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Start an occurrence',
        description:
          'Marks an upcoming or active occurrence as started (and ends any snooze). Starting ' +
          'one that is already started changes nothing.',
        params,
        response: { 200: occurrenceResponseSchema, ...actionErrors },
      },
    },
    async (request) => {
      const me = authOf(request).member;
      const now = ctx.config.clock();
      const { dto } = await actOnOccurrence(me, request.params.id, { type: 'start' }, now);
      return { occurrence: dto };
    },
  );

  r.get(
    '/api/occurrences',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'List occurrences',
        description:
          'Open occurrences of active tasks that are not snoozed. `today` (the default) is ' +
          'everything due today or earlier, already within its lead time, or undated, overdue ' +
          'first; `overdue` only what is past due; `upcoming` what is due from tomorrow up to ' +
          '`days` days ahead. "Today" is the household\'s local day.',
        querystring: occurrenceListQuerySchema,
        response: { 200: occurrencesResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) => {
      const { householdId } = authOf(request).member;
      const { view, memberId, taskId, days, limit } = request.query;
      const now = ctx.config.clock();
      const { timezone } = await householdSettings(ctx.db, householdId);
      const options = { now, timezone, days };

      const rows = await selectOccurrences(ctx.db)
        .where(
          and(
            listableOccurrences(householdId, now),
            memberId ? eq(occurrence.assigneeId, memberId) : undefined,
            taskId ? eq(occurrence.taskId, taskId) : undefined,
            viewCondition(view, options),
          ),
        )
        .orderBy(...viewOrder(options))
        .limit(limit);
      return { occurrences: rows.map((row) => toOccurrenceDto(row, options)) };
    },
  );

  r.get(
    '/api/occurrences/:id',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Get an occurrence',
        params,
        response: {
          200: occurrenceResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const { householdId } = authOf(request).member;
      const now = ctx.config.clock();
      const [dto] = await loadOccurrenceDtos(ctx.db, householdId, [request.params.id], {
        now,
        timezone: (await householdSettings(ctx.db, householdId)).timezone,
      });
      if (!dto) throw notFound('No such occurrence');
      return { occurrence: dto };
    },
  );
}
