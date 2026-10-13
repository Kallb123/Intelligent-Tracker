import cookie from '@fastify/cookie';
import { serviceHeartbeat, type Database } from '@tracker/db';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { registerGuards } from './auth/guards.js';
import { hashPassword, verifyPassword } from './auth/passwords.js';
import { FailureLimiter } from './auth/rate-limiter.js';
import { DEFAULT_AUTH_CONFIG, type AuthConfig } from './config.js';
import type { ApiContext } from './context.js';
import { registerErrorHandler } from './errors.js';
import { registerOpenApi } from './openapi.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerLinkRoutes } from './routes/links.js';
import { registerMemberRoutes } from './routes/members.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerOccurrenceRoutes } from './routes/occurrences.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerSecurity } from './security.js';

/** The worker counts as stale when it has not ticked for this long (it ticks every minute). */
export const WORKER_STALE_AFTER_MS = 5 * 60 * 1000;

const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('api'),
  time: z.string(),
  /** Only with a database: when the worker last ticked. Reported, never a failure. */
  worker: z.object({ lastBeatAt: z.iso.datetime().nullable(), stale: z.boolean() }).optional(),
});

export interface BuildServerOptions {
  logger?: FastifyServerOptions['logger'];
  /** Trust `X-Forwarded-*` headers (set when running behind a reverse proxy). */
  trustProxy?: boolean;
  /** Without a database only `/api/health` is served. */
  db?: Database;
  auth?: Partial<AuthConfig>;
}

/** Builds the Fastify instance (without listening) so tests can use `app.inject()`. */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
  });
  const config: AuthConfig = { ...DEFAULT_AUTH_CONFIG, ...options.auth };

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  registerSecurity(app, config);
  registerOpenApi(app);

  // The routes are added once the OpenAPI plugin is loaded, so that it sees all of them.
  app.after(() => {
    app.get(
      '/api/health',
      {
        schema: {
          tags: ['System'],
          summary: 'Health check',
          description:
            'Always 200 while the api is up. With a database it also reports the worker ' +
            'heartbeat: `stale` is set when there is none or it is over 5 minutes old.',
          response: { 200: healthResponseSchema },
        },
      },
      async () => {
        const now = config.clock();
        const body = { status: 'ok', service: 'api', time: now.toISOString() } as const;
        if (!options.db) return body;
        // A database error must not fail the health check: it is about the api itself.
        const [beat] = await options.db
          .select({ beatAt: serviceHeartbeat.beatAt })
          .from(serviceHeartbeat)
          .where(eq(serviceHeartbeat.service, 'worker'))
          .catch(() => []);
        const stale = !beat || now.getTime() - beat.beatAt.getTime() > WORKER_STALE_AFTER_MS;
        return { ...body, worker: { lastBeatAt: beat?.beatAt.toISOString() ?? null, stale } };
      },
    );

    if (options.db) {
      const ctx = createContext(options.db, config);
      void app.register(cookie);
      registerGuards(app, ctx);
      registerSetupRoutes(app, ctx);
      registerAuthRoutes(app, ctx);
      registerMemberRoutes(app, ctx);
      registerLinkRoutes(app, ctx);
      registerTaskRoutes(app, ctx);
      registerOccurrenceRoutes(app, ctx);
      registerNotificationRoutes(app, ctx);
    }
  });

  return app;
}

function createContext(db: Database, config: AuthConfig): ApiContext {
  const { perIdentifier, perIp, windowMs } = config.loginLimits;
  const limiter = (limit: number) => new FailureLimiter({ limit, windowMs, clock: config.clock });

  // Hashed lazily with the configured cost, then reused to make unknown-user logins cost the same.
  let dummyHash: Promise<string> | undefined;
  return {
    db,
    config,
    limiters: {
      identifier: limiter(perIdentifier),
      ip: limiter(perIp),
      passwordChange: limiter(perIdentifier),
    },
    async verifyDummy(password) {
      dummyHash ??= hashPassword('not-a-real-password', config.passwordParams);
      await verifyPassword(password, await dummyHash);
    },
  };
}
