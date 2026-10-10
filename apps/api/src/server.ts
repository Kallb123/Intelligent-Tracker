import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

/** Builds the Fastify instance (without listening) so tests can use `app.inject()`. */
export function buildServer(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'api',
    time: new Date().toISOString(),
  }));

  return app;
}
