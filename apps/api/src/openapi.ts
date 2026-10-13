import swagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { CSRF_HEADER } from './auth/guards.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Generates the OpenAPI 3 document from the routes' Zod schemas and serves it, without
 * authentication, at `GET /api/openapi.json`. Must be registered before the routes it documents.
 *
 * Routes guarded by `requireAuth`/`requireAdmin` are marked as needing the session cookie (and,
 * when they change anything, the CSRF header).
 */
export function registerOpenApi(app: FastifyInstance): void {
  void app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Intelligent Tracker API',
        description:
          'Household task tracker. Log in (or complete setup) to receive a session cookie and ' +
          'a CSRF token; send the token in the `X-CSRF-Token` header on every request that ' +
          'changes something. Errors are `{ "error": code, "message": text }`.',
        version: '0.0.0',
      },
      tags: [
        { name: 'System', description: 'Health.' },
        { name: 'Setup', description: 'First-run setup of a new instance.' },
        { name: 'Auth', description: 'Logging in and out, and the current session.' },
        { name: 'Members', description: 'Household members and invitations.' },
        { name: 'Links', description: 'One-time invite and password-reset links.' },
        { name: 'Tasks', description: 'Task definitions (the recurring series).' },
        { name: 'Occurrences', description: 'Dated instances of tasks, and acting on them.' },
        { name: 'Notifications', description: 'In-app notifications (the bell).' },
      ],
      components: {
        securitySchemes: {
          sessionCookie: { type: 'apiKey', in: 'cookie', name: 'session' },
          csrfToken: { type: 'apiKey', in: 'header', name: CSRF_HEADER },
        },
      },
    },
    transform(input) {
      const { schema, url } = jsonSchemaTransform(input);
      const hooks: unknown[] = [input.route.onRequest ?? []].flat();
      if (!hooks.includes(app.requireAuth) && !hooks.includes(app.requireAdmin)) {
        return { schema, url };
      }
      const security = SAFE_METHODS.has(String(input.route.method))
        ? [{ sessionCookie: [] }]
        : [{ sessionCookie: [], csrfToken: [] }];
      return { schema: { ...schema, security }, url };
    },
  });

  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());
}
