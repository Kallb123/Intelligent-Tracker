import type { FastifyServerOptions } from 'fastify';

/** One-time link tokens travel in the path; keep them out of the logs. */
export function redactUrl(url: string): string {
  return url.replace(/^(\/api\/(?:invites|password-resets)\/)[^/?#]+/, '$1[redacted]');
}

/** Pino options: JSON logs at `level`, with link tokens redacted from the request line. */
export function loggerOptions(level: string): Exclude<FastifyServerOptions['logger'], boolean> {
  return {
    level,
    serializers: {
      req: (request: { method: string; url: string; ip: string }) => ({
        method: request.method,
        url: redactUrl(request.url),
        remoteAddress: request.ip,
      }),
    },
  };
}
