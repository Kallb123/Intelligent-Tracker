import {
  activity,
  clearFutureOpenOccurrences,
  createTask,
  materialiseTask,
  member,
  normaliseBody,
  one,
  reassignOpenOccurrences,
  rematerialiseTask,
  replaceTaskLists,
  task,
  taskColumns,
  type TaskFieldValues,
} from '@tracker/db';
import { remapCursor } from '@tracker/core';
import {
  TASK_SCHEDULE_FIELDS,
  TASK_RECURRENCE_FIELDS,
  taskBodySchema,
  taskListQuerySchema,
  taskPatchSchema,
  taskResponseSchema,
  tasksResponseSchema,
} from '@tracker/shared';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authOf } from '../auth/guards.js';
import type { ApiContext } from '../context.js';
import { AppError, errorResponseSchema, notFound } from '../errors.js';
import {
  assertValidSchedule,
  changedFields,
  fieldsOfDto,
  withScheduleErrors,
} from '../tasks/fields.js';
import { householdSettings, loadTaskDto, loadTaskDtos } from '../tasks/payloads.js';

type Tx = Parameters<Parameters<ApiContext['db']['transaction']>[0]>[0];

/**
 * Tasks (the recurring "series"; the concrete instances are served by the occurrence routes).
 * All need a session, and every member can see and edit every task of their own household;
 * anything in another household is a 404:
 *   GET    /api/tasks?archived=   list active (or archived) tasks, by title
 *   POST   /api/tasks             create a task and its first occurrences
 *   GET    /api/tasks/:id         one task
 *   PATCH  /api/tasks/:id         change fields; assignees and milestones are replaced as a
 *                                 whole; a schedule change re-materialises the open occurrences;
 *                                 changing the assignees or mode re-plans a rotation
 *   DELETE /api/tasks/:id         delete the task and everything hanging off it
 */
export function registerTaskRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ id: z.uuid() });
  const tags = ['Tasks'];

  /** 400 unless every assignee is a member of the household. */
  async function assertAssignees(tx: Tx, householdId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.householdId, householdId), inArray(member.id, ids)));
    if (found.length !== ids.length) {
      throw new AppError(
        400,
        'invalid_assignee',
        'Every assignee must be a member of the household',
      );
    }
  }

  /**
   * The rotation cursor after the assignees or mode change: it keeps pointing at the member
   * whose turn it was, and starts from the first when the task has only just become a rotation
   * (and is 0 for a task that is not one, where it has no meaning).
   */
  function nextCursor(before: TaskFieldValues, after: TaskFieldValues, cursor: number): number {
    if (before.assignmentMode !== 'rotation' || after.assignmentMode !== 'rotation') return 0;
    return remapCursor(before.assigneeIds, cursor, after.assigneeIds);
  }

  r.get(
    '/api/tasks',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'List tasks',
        description:
          "The household's active tasks by title, or its archived ones with `archived=true`.",
        querystring: taskListQuerySchema,
        response: { 200: tasksResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) => {
      const rows = await ctx.db
        .select()
        .from(task)
        .where(
          and(
            eq(task.householdId, authOf(request).member.householdId),
            request.query.archived ? isNotNull(task.archivedAt) : isNull(task.archivedAt),
          ),
        )
        .orderBy(asc(task.title), asc(task.id));
      return { tasks: await loadTaskDtos(ctx.db, rows) };
    },
  );

  r.post(
    '/api/tasks',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Create a task',
        description:
          'Creates the task and materialises its occurrences straight away. A schedule the ' +
          'recurrence engine rejects (such as an unparseable RRULE) is `invalid_schedule`.',
        body: taskBodySchema,
        response: {
          201: taskResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const me = authOf(request).member;
      const settings = await householdSettings(ctx.db, me.householdId);
      const fields = normaliseBody(request.body, settings.defaultReminderProfile);
      await withScheduleErrors(() => assertValidSchedule(fields));

      const created = await withScheduleErrors(() =>
        ctx.db.transaction(async (tx) => {
          await assertAssignees(tx, me.householdId, fields.assigneeIds);
          const row = await createTask(tx, {
            householdId: me.householdId,
            createdBy: me.id,
            values: taskColumns(fields),
            assigneeIds: fields.assigneeIds,
            milestones: fields.milestones,
            now: ctx.config.clock(),
          });
          return loadTaskDto(tx, me.householdId, row.id);
        }),
      );
      return reply.code(201).send({ task: created });
    },
  );

  r.get(
    '/api/tasks/:id',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Get a task',
        params,
        response: { 200: taskResponseSchema, 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => ({
      task: await loadTaskDto(ctx.db, authOf(request).member.householdId, request.params.id),
    }),
  );

  r.patch(
    '/api/tasks/:id',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Update a task',
        description:
          'Send only the fields to change (`null` clears an optional one). The result must be a ' +
          "valid task as a whole. Changing the schedule replaces the task's upcoming and active " +
          'occurrences from today on; started, completed and overdue ones are kept. ' +
          '`archived: true` hides the task and removes its open occurrences; `false` restores it.',
        params,
        body: taskPatchSchema,
        response: {
          200: taskResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const me = authOf(request).member;
      const { archived, ...patch } = request.body;
      const now = ctx.config.clock();

      const updated = await withScheduleErrors(() =>
        ctx.db.transaction(async (tx) => {
          // Locking the row makes concurrent edits of one task take turns.
          const [row] = await tx
            .select({
              id: task.id,
              archivedAt: task.archivedAt,
              rotationCursor: task.rotationCursor,
            })
            .from(task)
            .where(and(eq(task.id, request.params.id), eq(task.householdId, me.householdId)))
            .for('no key update');
          if (!row) throw notFound('No such task');

          const stored = fieldsOfDto(await loadTaskDto(tx, me.householdId, row.id));
          const defined = Object.fromEntries(
            Object.entries(patch).filter(([, value]) => value !== undefined),
          );
          const parsed = taskBodySchema.safeParse({ ...stored, ...defined });
          if (!parsed.success) {
            throw new AppError(
              400,
              'validation_error',
              parsed.error.issues
                .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
                .join('; '),
            );
          }
          const fields = normaliseBody(parsed.data, stored.reminderProfile);
          assertValidSchedule(fields);
          const changed = changedFields(stored, fields);
          if (changed.includes('assigneeIds')) {
            await assertAssignees(tx, me.householdId, fields.assigneeIds);
          }

          const wasArchived = row.archivedAt !== null;
          const isArchived = archived ?? wasArchived;
          const archiveChanged = isArchived !== wasArchived;
          if (archiveChanged) changed.push('archived');
          if (changed.length === 0) return loadTaskDto(tx, me.householdId, row.id);

          await tx
            .update(task)
            .set({
              ...taskColumns(fields),
              ...(archiveChanged ? { archivedAt: isArchived ? now : null } : {}),
              ...(changed.includes('assigneeIds') || changed.includes('assignmentMode')
                ? { rotationCursor: nextCursor(stored, fields, row.rotationCursor) }
                : {}),
            })
            .where(eq(task.id, row.id));
          await replaceTaskLists(tx, row.id, {
            ...(changed.includes('assigneeIds') ? { assignees: fields.assigneeIds } : {}),
            ...(changed.includes('milestones') ? { milestones: fields.milestones } : {}),
          });

          const rescheduled = TASK_SCHEDULE_FIELDS.some((field) => changed.includes(field));
          if (isArchived) {
            if (rescheduled || archiveChanged)
              await clearFutureOpenOccurrences(tx, row.id, { now });
          } else {
            if (changed.includes('assigneeIds') || changed.includes('assignmentMode')) {
              await reassignOpenOccurrences(tx, row.id, { now });
            }
            if (rescheduled) {
              // Keep the cleared dates unless the recurrence itself changed.
              const keepDues = !TASK_RECURRENCE_FIELDS.some((field) => changed.includes(field));
              await rematerialiseTask(tx, row.id, { now, keepDues });
            } else if (archiveChanged) {
              await materialiseTask(tx, row.id, { now });
            }
          }

          await tx.insert(activity).values({
            householdId: me.householdId,
            memberId: me.id,
            taskId: row.id,
            kind: 'task.updated',
            data: { changed },
          });
          return loadTaskDto(tx, me.householdId, row.id);
        }),
      );
      return { task: updated };
    },
  );

  r.delete(
    '/api/tasks/:id',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Delete a task',
        description: 'Permanently deletes the task, its occurrences, assignees and milestones.',
        params,
        response: {
          204: z.null().describe('Deleted'),
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const me = authOf(request).member;
      await ctx.db.transaction(async (tx) => {
        const deleted = await tx
          .delete(task)
          .where(and(eq(task.id, request.params.id), eq(task.householdId, me.householdId)))
          .returning({ title: task.title });
        if (deleted.length === 0) throw notFound('No such task');
        // The task row is gone, so the log entry cannot point at it; the title keeps it readable.
        await tx.insert(activity).values({
          householdId: me.householdId,
          memberId: me.id,
          kind: 'task.deleted',
          data: { taskId: request.params.id, title: one(deleted).title },
        });
      });
      return reply.code(204).send(null);
    },
  );
}
