import vue from '@vitejs/plugin-vue';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { appVersionDefine } from './app-version.js';

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
  plugins: [
    rruleDefaultExport(),
    vue(),
    // The service worker (src/sw/sw.ts) is built to /sw.js with the app shell injected for
    // precaching. The web manifest stays the static one in public/, and the worker is registered
    // from src/pwa.ts (the plugin's virtual register module needs `workbox-window`, which the app
    // does not depend on), so neither is generated here.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: false,
      // Everything is bundled into sw.js: the app has no second worker file to serve uncached.
      injectManifest: {
        rollupFormat: 'iife',
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // Installable-app icons only; the large icon-font fallbacks are left to the browser.
        globIgnores: ['**/primeicons*.svg'],
      },
    }),
  ],
  define: appVersionDefine,
  server: { host: true, port: 5173, proxy },
  preview: { host: true, port: 4173, proxy },
});
