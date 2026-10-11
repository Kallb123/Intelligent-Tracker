import vue from '@vitejs/plugin-vue';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const apiTarget = process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000';
const proxy = { '/api': apiTarget, '/ical': apiTarget };

const VIRTUAL_RRULE = '\0rrule-default';

/**
 * `@tracker/core` reads rrule through its default export, which exists in the CommonJS build
 * Node loads (the api, the worker, the tests) but not in the ESM build bundlers pick, so the
 * browser bundle would fail with "default is not exported". This serves a default export built
 * from the ESM namespace instead, leaving core untouched.
 */
function rruleDefaultExport(): Plugin {
  const coreDir = fileURLToPath(new URL('../../packages/core/', import.meta.url));
  const esmEntry = createRequire(`${coreDir}package.json`).resolve('rrule/dist/esm/index.js');
  return {
    name: 'rrule-default-export',
    enforce: 'pre',
    resolveId(id, importer) {
      // Only core's own import: the shim's import of the ESM entry is an absolute path.
      return id === 'rrule' && importer?.startsWith(coreDir) ? VIRTUAL_RRULE : undefined;
    },
    load(id) {
      return id === VIRTUAL_RRULE
        ? `import * as rrule from ${JSON.stringify(esmEntry)};\nexport default rrule;\n`
        : undefined;
    },
  };
}

export default defineConfig({
  plugins: [rruleDefaultExport(), vue()],
  server: { host: true, port: 5173, proxy },
  preview: { host: true, port: 4173, proxy },
});
