import { cachedBankHolidays, household, template, one } from '@tracker/db';
import { scheduleFromTask } from '@tracker/core';
import {
  bankHolidaysResponseSchema,
  UK_TEMPLATES,
  templateBodySchema,
  templateResponseSchema,
  templateScheduleFields,
  templatesResponseSchema,
} from '@tracker/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authOf } from '../auth/guards.js';
import type { ApiContext } from '../context.js';
import { errorResponseSchema, notFound } from '../errors.js';
import { withScheduleErrors } from '../tasks/fields.js';

export function registerTemplateRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['Templates'];
  const params = z.object({ id: z.uuid() });
  r.get(
    '/api/bank-holidays',
    {
      onRequest: app.requireAuth,
      schema: {
        tags: ['Bank holidays'],
        summary: 'List cached household bank holidays',
        response: { 200: bankHolidaysResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) => {
      const h = one(
        await ctx.db
          .select()
          .from(household)
          .where(eq(household.id, authOf(request).member.householdId)),
      );
      return { holidays: await cachedBankHolidays(ctx.db, h.bankHolidayRegion) };
    },
  );
  r.get(
    '/api/templates',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'List UK and household templates',
        response: { 200: templatesResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) => {
      const rows = await ctx.db
        .select()
        .from(template)
        .where(eq(template.householdId, authOf(request).member.householdId))
        .orderBy(asc(template.title), asc(template.id));
      return { templates: [...UK_TEMPLATES, ...rows.map((row) => ({ ...row, builtIn: false }))] };
    },
  );
  r.post(
    '/api/templates',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Create a household template',
        body: templateBodySchema,
        response: {
          201: templateResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await withScheduleErrors(() =>
        scheduleFromTask(templateScheduleFields(request.body.defaults)),
      );
      const row = one(
        await ctx.db
          .insert(template)
          .values({ ...request.body, householdId: authOf(request).member.householdId })
          .returning(),
      );
      return reply.code(201).send({ template: { ...row, builtIn: false } });
    },
  );
  r.patch(
    '/api/templates/:id',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Replace a household template',
        params,
        body: templateBodySchema,
        response: {
          200: templateResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      await withScheduleErrors(() =>
        scheduleFromTask(templateScheduleFields(request.body.defaults)),
      );
      const [row] = await ctx.db
        .update(template)
        .set(request.body)
        .where(
          and(
            eq(template.id, request.params.id),
            eq(template.householdId, authOf(request).member.householdId),
          ),
        )
        .returning();
      if (!row) throw notFound('No such user template');
      return { template: { ...row, builtIn: false } };
    },
  );
  r.delete(
    '/api/templates/:id',
    {
      onRequest: app.requireAuth,
      schema: {
        tags,
        summary: 'Delete a household template',
        params,
        response: {
          204: z.null(),
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rows = await ctx.db
        .delete(template)
        .where(
          and(
            eq(template.id, request.params.id),
            eq(template.householdId, authOf(request).member.householdId),
          ),
        )
        .returning({ id: template.id });
      if (!rows.length) throw notFound('No such user template');
      return reply.code(204).send(null);
    },
  );
}
