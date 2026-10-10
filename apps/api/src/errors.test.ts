import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AppError, registerErrorHandler } from './errors.js';

function appWith(routes: (app: ReturnType<typeof Fastify>) => void) {
  const app = Fastify();
  registerErrorHandler(app);
  routes(app);
  return app;
}

describe('error handler', () => {
  it('sends AppErrors with their status, code and headers', async () => {
    const app = appWith((a) =>
      a.get('/x', async () => {
        throw new AppError(429, 'slow_down', 'Too fast', { 'retry-after': '5' });
      }),
    );
    const res = await app.inject({ url: '/x' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json()).toEqual({ error: 'slow_down', message: 'Too fast' });
  });

  it('hides the details of unexpected errors', async () => {
    const app = appWith((a) =>
      a.get('/x', async () => {
        throw new Error('connection string postgres://user:secret@host');
      }),
    );
    const res = await app.inject({ url: '/x' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error', message: 'Something went wrong' });
  });
});
