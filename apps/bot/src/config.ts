/** How often the bot looks for group reminders to send, unless `DELIVERY_INTERVAL_MS` says otherwise. */
export const DEFAULT_DELIVERY_INTERVAL_MS = 10_000;

export interface BotConfig {
  /** From @BotFather. Without it the bot only idles. */
  token: string | undefined;
  /** Without it the bot only idles: linking and reminders both live in the database. */
  databaseUrl: string | undefined;
  deliveryIntervalMs: number;
  /** Where people reach the web app, so replies can point them at it. */
  publicBaseUrl: string | undefined;
  /** Touched every minute so the container healthcheck can tell the process is alive. */
  heartbeatFile: string | undefined;
}

/** No faster than this: a smaller value would hammer the database with a near-continuous loop. */
export const MIN_DELIVERY_INTERVAL_MS = 1000;

/** A trimmed, non-empty value, or undefined. */
function present(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** The configured delivery interval when it is a finite number of at least 1000, else the default. */
function deliveryInterval(value: string | undefined): number {
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= MIN_DELIVERY_INTERVAL_MS ? ms : DEFAULT_DELIVERY_INTERVAL_MS;
}

/**
 * Reads the bot's settings from the environment:
 * - `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`: both needed for the bot to do anything.
 * - `DELIVERY_INTERVAL_MS`: how often group reminders are sent (default 10 seconds; at least 1000).
 * - `PUBLIC_BASE_URL`: the web app's address, mentioned in replies that send people there.
 * - `HEARTBEAT_FILE`: see `BotConfig.heartbeatFile`.
 */
export function configFromEnv(env: Record<string, string | undefined>): BotConfig {
  return {
    token: present(env['TELEGRAM_BOT_TOKEN']),
    databaseUrl: present(env['DATABASE_URL']),
    deliveryIntervalMs: deliveryInterval(env['DELIVERY_INTERVAL_MS']),
    publicBaseUrl: present(env['PUBLIC_BASE_URL'])?.replace(/\/+$/, ''),
    heartbeatFile: present(env['HEARTBEAT_FILE']),
  };
}
