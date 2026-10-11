import { readFileSync } from 'node:fs';

/**
 * The app has one version, the `version` field in the root package.json. Vite and vitest both
 * spread this into `define`, so `__APP_VERSION__` is the same string in the build and in tests.
 */
const rootPackage = new URL('../../package.json', import.meta.url);
const { version } = JSON.parse(readFileSync(rootPackage, 'utf8')) as { version: string };

export const appVersionDefine = { __APP_VERSION__: JSON.stringify(version) };
