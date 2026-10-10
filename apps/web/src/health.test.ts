import { describe, expect, it } from 'vitest';
import { describeHealth, fetchHealth } from './health.js';

function fakeFetch(res: Response | Error): typeof fetch {
  return () => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res));
}

describe('fetchHealth', () => {
  it('returns ok for a healthy response', async () => {
    const body = { status: 'ok', service: 'api', time: '2026-01-01T00:00:00.000Z' };
    const result = await fetchHealth(fakeFetch(Response.json(body)));
    expect(result).toEqual({ ok: true, service: 'api', time: body.time });
  });

  it('reports HTTP errors', async () => {
    const result = await fetchHealth(fakeFetch(new Response('boom', { status: 502 })));
    expect(result).toEqual({ ok: false, error: 'HTTP 502' });
  });

  it('reports unexpected bodies', async () => {
    const result = await fetchHealth(fakeFetch(Response.json({ status: 'degraded' })));
    expect(result).toEqual({ ok: false, error: 'unexpected response' });
  });

  it('reports network failures', async () => {
    const result = await fetchHealth(fakeFetch(new TypeError('fetch failed')));
    expect(result).toEqual({ ok: false, error: 'fetch failed' });
  });
});

describe('describeHealth', () => {
  it('describes both outcomes', () => {
    expect(describeHealth({ ok: true, service: 'api', time: 't' })).toBe('API is ok (api, t)');
    expect(describeHealth({ ok: false, error: 'HTTP 502' })).toBe('API error: HTTP 502');
  });
});
