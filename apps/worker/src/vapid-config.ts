/** The VAPID identity the worker signs Web Push requests with. */
export interface VapidConfig {
  /** URL-safe base64; the api serves it to browsers as the `applicationServerKey`. */
  publicKey: string;
  privateKey: string;
  /** A `mailto:` or `https:` URL the push services can contact the sender at. */
  subject: string;
}

export type VapidSettings =
  | { enabled: true; config: VapidConfig }
  /** Push is off; `warning` says why when that is probably not what the operator meant. */
  | { enabled: false; warning?: string };

function setting(env: Record<string, string | undefined>, name: string): string | undefined {
  // An empty value is how docker compose passes an unset variable.
  return env[name]?.trim() || undefined;
}

/**
 * Reads the Web Push settings from the environment: `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`
 * (generate a pair with `pnpm vapid:generate`) and `VAPID_SUBJECT`, a `mailto:` or `https:` URL.
 * Without a subject, `PUBLIC_BASE_URL` is used when it is https. With neither key set, push is
 * simply off (the default install); with only one of them, or no usable subject, it is off with
 * a warning, so a half-finished setup is noticed rather than silently ignored.
 */
export function readVapidSettings(env: Record<string, string | undefined>): VapidSettings {
  const publicKey = setting(env, 'VAPID_PUBLIC_KEY');
  const privateKey = setting(env, 'VAPID_PRIVATE_KEY');
  if (!publicKey && !privateKey) return { enabled: false };
  if (!publicKey || !privateKey) {
    return {
      enabled: false,
      warning: 'Web Push is off: set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY',
    };
  }

  const explicit = setting(env, 'VAPID_SUBJECT');
  if (explicit) {
    if (!/^(mailto:\S+|https:\/\/\S+)$/i.test(explicit)) {
      return {
        enabled: false,
        warning: 'Web Push is off: VAPID_SUBJECT must be a mailto: address or an https: URL',
      };
    }
    return { enabled: true, config: { publicKey, privateKey, subject: explicit } };
  }

  const baseUrl = setting(env, 'PUBLIC_BASE_URL');
  if (baseUrl && /^https:\/\/\S+$/i.test(baseUrl)) {
    return { enabled: true, config: { publicKey, privateKey, subject: baseUrl } };
  }
  return {
    enabled: false,
    warning:
      'Web Push is off: set VAPID_SUBJECT (a mailto: address or an https: URL), or serve the app over https and set PUBLIC_BASE_URL',
  };
}
