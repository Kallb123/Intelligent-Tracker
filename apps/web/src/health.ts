export type HealthResult =
  { ok: true; service: string; time: string } | { ok: false; error: string };

/** Calls the API health endpoint; never throws. */
export async function fetchHealth(
  fetchFn: typeof fetch = fetch,
  url = '/api/health',
): Promise<HealthResult> {
  try {
    const res = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && 'status' in body && body.status === 'ok') {
      const { service, time } = body as { service?: unknown; time?: unknown };
      return { ok: true, service: String(service ?? 'api'), time: String(time ?? '') };
    }
    return { ok: false, error: 'unexpected response' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function describeHealth(result: HealthResult): string {
  return result.ok ? `API is ok (${result.service}, ${result.time})` : `API error: ${result.error}`;
}
