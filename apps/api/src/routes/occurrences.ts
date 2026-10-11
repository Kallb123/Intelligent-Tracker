import {
  activity,
  consumeRotationTurn,
  materialiseTask,
  occurrence,
  task,
  type DbOrTransaction,
  type NewOccurrence,
} from '@tracker/db';
import {
  OPEN_OCCURRENCE_STATUSES,
  occurrenceCompletionResponseSchema,
  occurrenceListQuerySchema,
  occurrenceResponseSchema,
  occurrencesResponseSchema,
  snoozeBodySchema,
  type OccurrenceDto,
  type OccurrenceStatus,
} from '@tracker/shared';
import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authOf } from '../auth/guards.js';
import type { ApiContext } from '../context.js';
import { AppError, conflict, errorResponseSchema, notFound } from '../errors.js';
import { viewCondition, viewOrder } from '../tasks/occurrence-views.js';
import {
  householdSettings,
  loadOccurrenceDtos,
  type OverdueClock,
  selectOccurrences,
  toOccurrenceDto,
} from '../tasks/payloads.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_STARTED = ['upcoming', 'active'] as const satisfies OccurrenceStatus[];

/** What a status change does to an occurrence and how it is logged. */
interface Transition {
  /** Statuses the occurrence may currently have; any other is `occurrence_closed`. */
  from: readonly OccurrenceStatus[];
  changes: Partial<Pick<NewOccurrence, 'status' | 'snoozedUntil' | 'completedAt' | 'completedBy'>>;
  activityKind: string;
  activityData?: Record<string, unknown>;
  /** Treated as success without doing anything when the occurrence is already in this status. */
  idempotentIn?: OccurrenceStatus;
  /** Runs in the same transaction after the change; returns ids of occurrences it created. */
  after?: (tx: DbOrTransaction, changed: ChangedOccurrence) => Promise<string[]>;
}

/** An occurrence that a `Transition` has just changed. */
interface ChangedOccurrence {
  id: string;
  taskId: string;
  /** Its status before the change. */
  previousStatus: OccurrenceStatus;
}

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
   * Applies `transition` to the household's occurrence and returns it. The change is a single
   * conditional UPDATE, so of two simultaneous requests only one finds the occurrence still
   * open; the other gets 409 (or, for `start`, the already-started occurrence).
   */
  async function transitionOccurrence(
    householdId: string,
    memberId: string,
    occurrenceId: string,
    transition: Transition,
    now: Date,
  ): Promise<{ dto: OccurrenceDto; createdIds: string[]; clock: OverdueClock }> {
    const { timezone } = await householdSettings(ctx.db, householdId);
    const clock = { now, timezone };

    return ctx.db.transaction(async (tx) => {
      const owned = tx.select({ id: task.id }).from(task).where(eq(task.householdId, householdId));
      // Lock order is task, then occurrence, like every other writer, so the actions cannot
      // deadlock with task edits, away changes or the worker. The lock on the occurrence also
      // makes the status read below and the change after it one step, so exactly one request
      // sees the occurrence not yet started and uses up the turn.
      const [ref] = await tx
        .select({ taskId: occurrence.taskId })
        .from(occurrence)
        .where(and(eq(occurrence.id, occurrenceId), inArray(occurrence.taskId, owned)));
      if (!ref) throw notFound('No such occurrence');
      await tx
        .select({ id: task.id })
        .from(task)
        .where(eq(task.id, ref.taskId))
        .for('no key update');
      const [before] = await tx
        .select({ status: occurrence.status })
        .from(occurrence)
        .where(eq(occurrence.id, occurrenceId))
        .for('no key update');
      // Gone while waiting for the lock (the task was deleted or rescheduled).
      if (!before) throw notFound('No such occurrence');
      const changed = await tx
        .update(occurrence)
        .set(transition.changes)
        .where(
          and(
            eq(occurrence.id, occurrenceId),
            inArray(occurrence.status, [...transition.from]),
            inArray(occurrence.taskId, owned),
          ),
        )
        .returning({ taskId: occurrence.taskId });

      const [current] = await selectOccurrences(tx)
        .where(and(eq(occurrence.id, occurrenceId), eq(task.householdId, householdId)))
        .limit(1);
      if (!current) throw notFound('No such occurrence');
      const changedRow = changed[0];
      if (changedRow === undefined) {
        if (current.occurrence.status === transition.idempotentIn) {
          return { dto: toOccurrenceDto(current, clock), createdIds: [], clock };
        }
        throw conflict(
          'occurrence_closed',
          `That occurrence is already ${current.occurrence.status}`,
        );
      }

      await tx.insert(activity).values({
        householdId,
        memberId,
        taskId: changedRow.taskId,
        occurrenceId,
        kind: transition.activityKind,
        data: { title: current.task.title, ...transition.activityData },
      });
      const createdIds =
        (await transition.after?.(tx, {
          id: occurrenceId,
          taskId: changedRow.taskId,
          previousStatus: before.status,
        })) ?? [];
      return { dto: toOccurrenceDto(current, clock), createdIds, clock };
    });
  }

  /** Uses up the assignee's rotation turn (a no-op if the occurrence had already been started). */
  const consumeTurn = (tx: DbOrTransaction, changed: ChangedOccurrence, now: Date) =>
    consumeRotationTurn(tx, changed.id, { now, previousStatus: changed.previousStatus });

  /** Complete or skip: closes the occurrence and lets the schedule produce the next one. */
  function registerClose(
    action: 'complete' | 'skip',
    status: 'done' | 'skipped',
    summary: string,
    description: string,
  ): void {
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
        const result = await transitionOccurrence(
          me.householdId,
          me.id,
          request.params.id,
          {
            from: OPEN_OCCURRENCE_STATUSES,
            changes: { status, completedAt: now, completedBy: me.id, snoozedUntil: null },
            activityKind: `occurrence.${status === 'done' ? 'completed' : 'skipped'}`,
            after: async (tx, changed) => {
              await consumeTurn(tx, changed, now);
              return (await materialiseTask(tx, changed.taskId, { now })).occurrenceIds;
            },
          },
          now,
        );
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
    'done',
    'Complete an occurrence',
    'Marks an open occurrence done. For an `after_completion` task the next occurrence is ' +
      'created straight away and returned as `next`.',
  );
  registerClose(
    'skip',
    'skipped',
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
        'until' in body ? new Date(body.until) : new Date(now.getTime() + body.days * DAY_MS);
      if (until <= now)
        throw new AppError(400, 'invalid_snooze', 'Snooze until a time in the future');

      const { dto } = await transitionOccurrence(
        me.householdId,
        me.id,
        request.params.id,
        {
          from: OPEN_OCCURRENCE_STATUSES,
          changes: { snoozedUntil: until },
          activityKind: 'occurrence.snoozed',
          activityData: { until: until.toISOString() },
        },
        now,
      );
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
      const { dto } = await transitionOccurrence(
        me.householdId,
        me.id,
        request.params.id,
        {
          from: NOT_STARTED,
          changes: { status: 'started', snoozedUntil: null },
          activityKind: 'occurrence.started',
          idempotentIn: 'started',
          after: async (tx, changed) => {
            await consumeTurn(tx, changed, now);
            return [];
          },
        },
        now,
      );
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
            eq(task.householdId, householdId),
            isNull(task.archivedAt),
            inArray(occurrence.status, [...OPEN_OCCURRENCE_STATUSES]),
            or(isNull(occurrence.snoozedUntil), lte(occurrence.snoozedUntil, now)),
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
