import { readFile } from 'node:fs/promises';
import type { Database } from '@tracker/db';
import { afterAll, describe, expect, it } from 'vitest';
import { buildOpenApiDocument, serialiseOpenApiDocument } from './openapi-document.js';
import { buildServer } from './server.js';

interface Operation {
  tags?: string[];
  summary?: string;
  security?: unknown[];
}
type Paths = Record<string, Record<string, Operation>>;

const committed = new URL('../openapi.json', import.meta.url);

describe('OpenAPI document', () => {
  it('matches the committed apps/api/openapi.json (run `pnpm openapi` to update it)', async () => {
    const expected = serialiseOpenApiDocument(await buildOpenApiDocument());
    expect(await readFile(committed, 'utf8')).toBe(expected);
  });

  it('describes every route with a tag and a summary', async () => {
    const doc = (await buildOpenApiDocument()) as { paths: Paths };
    const operations = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, op]) => ({ route: `${method} ${path}`, op })),
    );

    expect(operations.length).toBeGreaterThan(20);
    for (const { route, op } of operations) {
      expect([route, op.tags?.length]).toEqual([route, 1]);
      expect([route, op.summary]).toEqual([route, expect.any(String)]);
    }
    expect(doc.paths['/api/openapi.json']).toBeUndefined();
  });

  it('documents the task and occurrence routes, and marks the guarded ones as needing a session', async () => {
    const doc = (await buildOpenApiDocument()) as { paths: Paths };
    const routes = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );

    expect(routes).toEqual(
      expect.arrayContaining([
        'GET /api/tasks',
        'POST /api/tasks',
        'GET /api/tasks/{id}',
        'PATCH /api/tasks/{id}',
        'DELETE /api/tasks/{id}',
        'GET /api/occurrences',
        'GET /api/occurrences/{id}',
        'POST /api/occurrences/{id}/complete',
        'POST /api/occurrences/{id}/skip',
        'POST /api/occurrences/{id}/snooze',
        'POST /api/occurrences/{id}/start',
      ]),
    );
    expect(doc.paths['/api/tasks']?.['get']?.security).toEqual([{ sessionCookie: [] }]);
    expect(doc.paths['/api/tasks']?.['post']?.security).toEqual([
      { sessionCookie: [], csrfToken: [] },
    ]);
    expect(doc.paths['/api/auth/login']?.['post']?.security).toBeUndefined();
  });

  describe('GET /api/openapi.json', () => {
    const app = buildServer({ db: {} as Database });
    afterAll(() => app.close());

    it('serves the document without a session', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json()).toEqual(await buildOpenApiDocument());
    });
  });
});
