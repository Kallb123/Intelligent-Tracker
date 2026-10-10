import { fileURLToPath } from 'node:url';

/** Returns DATABASE_URL, loading the repo-root `.env` first if there is one. Exits if unset. */
export function requireDatabaseUrl(): string {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../../.env', import.meta.url)));
  } catch {
    // No .env file: rely on the environment.
  }
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set (see .env.example).');
    process.exit(1);
  }
  return url;
}
