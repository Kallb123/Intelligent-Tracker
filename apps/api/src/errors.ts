import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { z } from 'zod';

/** An error the client should see: `{ error: code, message }` with the given status. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** The body of every error response, for the OpenAPI document. */
export const errorResponseSchema = z.object({ error: z.string(), message: z.string() });

export const unauthorized = (message = 'Log in to continue') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const tooManyRequests = (retryAfterMs: number) =>
  new AppError(429, 'too_many_attempts', 'Too many failed attempts. Try again later.', {
    'retry-after': String(Math.ceil(retryAfterMs / 1000)),
  });

/** Turns every error into the `{ error, message }` shape; unexpected ones are logged, not leaked. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).headers(err.headers).send({
        error: err.code,
        message: err.message,
      });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: 'validation_error',
        message: err.validation
          .map((issue) => `${issue.instancePath.replace(/^\//, '') || 'request'}: ${issue.message}`)
          .join('; '),
      });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({
        error: (err.code ?? 'bad_request').toLowerCase(),
        message: err.message,
      });
    }
    request.log.error(err);
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'not_found', message: 'Not found' }),
  );
}
