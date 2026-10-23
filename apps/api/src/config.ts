import type { PasswordParams } from './auth/passwords.js';
import { DEFAULT_PASSWORD_PARAMS } from './auth/passwords.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface LoginLimits {
  /** Failed attempts allowed per username/email within the window before locking it out. */
  perIdentifier: number;
  /** Failed attempts allowed per client IP within the window. */
  perIp: number;
  windowMs: number;
}

export interface AuthConfig {
  /** Sets the `Secure` flag (and `__Host-` prefix) on the session cookie. Off for plain http. */
  cookieSecure: boolean;
  /** Public origin used to build invite and reset links; falls back to the request's host. */
  publicBaseUrl: string | undefined;
  /** The Telegram bot's username (no `@`), for `t.me` deep links; undefined when not configured. */
  telegramBotUsername: string | undefined;
  /**
   * The VAPID public key (URL-safe base64) browsers subscribe to Web Push with; undefined when push
   * is not configured, in which case the api refuses subscriptions and reports no key.
   */
  vapidPublicKey: string | undefined;
  /** Session length without "remember me" (also the cookie is then a browser-session cookie). */
  sessionTtlMs: number;
  /** Session length with "remember me". */
  rememberTtlMs: number;
  inviteTtlMs: number;
  resetTtlMs: number;
  passwordParams: PasswordParams;
  loginLimits: LoginLimits;
  /** Source of "now" for expiries and rate limits, replaceable in tests. */
  clock: () => Date;
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  cookieSecure: false,
  publicBaseUrl: undefined,
  telegramBotUsername: undefined,
  vapidPublicKey: undefined,
  sessionTtlMs: DAY,
  rememberTtlMs: 30 * DAY,
  inviteTtlMs: 7 * DAY,
  resetTtlMs: DAY,
  passwordParams: DEFAULT_PASSWORD_PARAMS,
  loginLimits: { perIdentifier: 5, perIp: 10, windowMs: 15 * MINUTE },
  clock: () => new Date(),
};

export interface RuntimeConfig {
  auth: Partial<AuthConfig>;
  trustProxy: boolean;
}

/**
 * Reads the deployment settings from the environment:
 * - `PUBLIC_BASE_URL`: where users reach the app; used for invite links.
 * - `TELEGRAM_BOT_USERNAME`: the bot's username, with or without a leading `@`; lets the web app
 *   offer a `t.me` link for connecting Telegram. Without it, people send the code to the bot by hand.
 * - `VAPID_PUBLIC_KEY`: the Web Push (VAPID) public key; lets the web app offer push notifications.
 *   The worker needs the matching private key to send them.
 * - `COOKIE_SECURE`: `true`/`false`; defaults to true when `PUBLIC_BASE_URL` is https.
 * - `TRUST_PROXY`: `true` when the api sits behind a reverse proxy (as in Docker), so the
 *   client IP used for login rate limiting comes from `X-Forwarded-For`.
 */
export function configFromEnv(env: Record<string, string | undefined>): RuntimeConfig {
  const publicBaseUrl = env['PUBLIC_BASE_URL']?.trim().replace(/\/+$/, '') || undefined;
  const botUsername = env['TELEGRAM_BOT_USERNAME']?.trim().replace(/^@+/, '') || undefined;
  const vapidPublicKey = env['VAPID_PUBLIC_KEY']?.trim() || undefined;
  const secure = env['COOKIE_SECURE']?.trim().toLowerCase();
  return {
    auth: {
      ...(publicBaseUrl ? { publicBaseUrl } : {}),
      ...(botUsername ? { telegramBotUsername: botUsername } : {}),
      ...(vapidPublicKey ? { vapidPublicKey } : {}),
      cookieSecure: secure ? secure === 'true' : (publicBaseUrl?.startsWith('https://') ?? false),
    },
    trustProxy: env['TRUST_PROXY']?.trim().toLowerCase() === 'true',
  };
}
