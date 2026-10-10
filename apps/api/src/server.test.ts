import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from './index.js';

describe('GET /api/health', () => {
  const app = buildServer();
  afterAll(() => app.close());

  it('reports ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = res.json<{ status: string; service: string; time: string }>();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('api');
    expect(new Date(body.time).toISOString()).toBe(body.time);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
  });
});
