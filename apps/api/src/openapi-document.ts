import type { Database } from '@tracker/db';
import { buildServer } from './server.js';

/**
 * The OpenAPI document of the full api, built without a database: the routes are registered
 * (which is all the document needs) but nothing ever queries the placeholder.
 */
export async function buildOpenApiDocument(): Promise<unknown> {
  const app = buildServer({ db: {} as Database });
  try {
    await app.ready();
    return app.swagger();
  } finally {
    await app.close();
  }
}

/** The text of `openapi.json`: stable, pretty-printed, newline-terminated. */
export function serialiseOpenApiDocument(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
