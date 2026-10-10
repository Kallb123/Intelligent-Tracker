import { writeFile } from 'node:fs/promises';
import { buildOpenApiDocument, serialiseOpenApiDocument } from './openapi-document.js';

// `pnpm openapi`: regenerates apps/api/openapi.json, which is committed and checked by a test.
const target = new URL('../openapi.json', import.meta.url);
await writeFile(target, serialiseOpenApiDocument(await buildOpenApiDocument()));
console.log(`wrote ${target.pathname}`);
