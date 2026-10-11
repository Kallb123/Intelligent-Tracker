import { household, member } from '@tracker/db';
import {
  sessionInfoSchema,
  setupBodySchema,
  setupStatusSchema,
  type SessionInfo,
} from '@tracker/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { hashPassword } from '../auth/passwords.js';
import { startSession } from '../auth/sessions.js';
import { sessionInfo } from '../auth/payloads.js';
import type { ApiContext } from '../context.js';
import { conflict } from '../errors.js';
import { one } from '../rows.js';

/**
 * First-run setup (public, but only while no household exists):
 *   GET  /api/setup  -> { needsSetup }
 *   POST /api/setup  -> creates the household and its admin, logs the admin in (201)
 */

/** Arbitrary key for the advisory lock that serialises concurrent setup attempts. */
const SETUP_LOCK_KEY = 7_452_002;

export function registerSetupRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const hasHousehold = async (): Promise<boolean> => {
    const [row] = await ctx.db.select({ id: household.id }).from(household).limit(1);
    return row !== undefined;
  };
  const alreadySetUp = () => conflict('already_set_up', 'This household has already been set up');

  r.get(
    '/api/setup',
    {
      schema: {
        tags: ['Setup'],
        summary: 'Is first-run setup needed?',
        response: { 200: setupStatusSchema },
      },
    },
    async () => ({ needsSetup: !(await hasHousehold()) }),
  );

  r.post(
    '/api/setup',
    {
      schema: {
        tags: ['Setup'],
        summary: 'Create the household and its first admin',
        body: setupBodySchema,
        response: { 201: sessionInfoSchema },
      },
    },
    async (request, reply): Promise<SessionInfo> => {
      const body = request.body;
      // Cheap early exit, so a finished instance never spends a password hash on this.
      if (await hasHousehold()) throw alreadySetUp();
      const passwordHash = await hashPassword(body.password, ctx.config.passwordParams);

      // The lock makes "no household yet" and the inserts one atomic step, so two simultaneous
      // setups cannot both succeed.
      const admin = await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
        const [existing] = await tx.select({ id: household.id }).from(household).limit(1);
        if (existing) throw alreadySetUp();

        const h = one(await tx.insert(household).values({ name: body.householdName }).returning());
        return one(
          await tx
            .insert(member)
            .values({
              householdId: h.id,
              name: body.name,
              username: body.username,
              email: body.email ?? null,
              role: 'admin',
              passwordHash,
            })
            .returning(),
        );
      });

      const { csrfToken } = await startSession(ctx, request, reply, admin, body.remember);
      return reply.code(201).send(await sessionInfo(ctx, admin, csrfToken));
    },
  );
}
