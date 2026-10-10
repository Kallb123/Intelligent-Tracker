// Bundles the current app's src/main.ts (run from an app directory) into dist/main.js.
// Workspace packages (consumed from TS source) and npm dependencies are all inlined, so the
// production image needs no node_modules. The banner gives bundled CommonJS deps a `require`.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
});
