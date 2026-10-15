import { APP_NAME } from './index.js';

export type Fields = Record<string, unknown>;

/** The bot's log output: one JSON object per line, like the other services. */
export interface Logger {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

export function createLogger(): Logger {
  const write =
    (level: 'info' | 'warn' | 'error') =>
    (msg: string, fields: Fields = {}): void =>
      console.log(JSON.stringify({ level, time: Date.now(), service: APP_NAME, msg, ...fields }));
  return { info: write('info'), warn: write('warn'), error: write('error') };
}

/** A logger that discards everything, for tests and as the default. */
export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Drizzle wraps driver errors ("Failed query: ..."); the `cause` says what Postgres objected to. */
export function errorFields(error: unknown): Fields {
  if (!(error instanceof Error)) return { error };
  const { cause } = error;
  return { error: error.message, ...(cause instanceof Error ? { cause: cause.message } : {}) };
}
