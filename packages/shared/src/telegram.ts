import { z } from 'zod';
import { DIGEST_KINDS, REMINDER_KINDS } from './notifications.js';

/** Request and response shapes of the Telegram linking API (docs/PLAN.md 5.1). */

/**
 * Everything the house group is sent on its own: each reminder kind (one message per reminder
 * that comes due) and each scheduled digest. An admin can switch each type off for the household;
 * in-app notifications, Web Push and the bot's on-demand commands (`/today`, `/digest`, ...) are
 * not affected. The lists are the single sources of the kinds, so a new reminder or digest kind
 * is a notification type here without retyping it.
 */
export const TELEGRAM_NOTIFICATION_TYPES = [...REMINDER_KINDS, ...DIGEST_KINDS] as const;

export type TelegramNotificationType = (typeof TELEGRAM_NOTIFICATION_TYPES)[number];

/** Whether each notification type is switched on for the house group. */
export const telegramNotificationsSchema = z.object(
  Object.fromEntries(TELEGRAM_NOTIFICATION_TYPES.map((type) => [type, z.boolean()])) as Record<
    TelegramNotificationType,
    z.ZodBoolean
  >,
);

/**
 * Switches to change: only the types listed are touched, the rest keep their setting. Unknown
 * keys are refused, as is a body that changes nothing.
 */
export const telegramNotificationsPatchSchema = z
  .object(
    Object.fromEntries(
      TELEGRAM_NOTIFICATION_TYPES.map((type) => [type, z.boolean().optional()]),
    ) as Record<TelegramNotificationType, z.ZodOptional<z.ZodBoolean>>,
  )
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Change at least one switch' });

export type TelegramNotifications = z.infer<typeof telegramNotificationsSchema>;
export type TelegramNotificationsPatch = z.infer<typeof telegramNotificationsPatchSchema>;

/**
 * The household's switches from what is stored: the list of types that are switched OFF, so a
 * type added later is on until someone turns it off. Strings that are not a known type (a type
 * since removed) are ignored.
 */
export function telegramNotificationsFromDisabled(
  disabled: readonly string[],
): TelegramNotifications {
  return Object.fromEntries(
    TELEGRAM_NOTIFICATION_TYPES.map((type) => [type, !disabled.includes(type)]),
  ) as TelegramNotifications;
}

/** Whether the household's group is sent notifications of `type`, given its stored off-list. */
export function telegramNotificationEnabled(
  disabled: readonly string[],
  type: TelegramNotificationType,
): boolean {
  return !disabled.includes(type);
}

export const telegramStatusSchema = z.object({
  /** The bot's username (no `@`) when the deployment configured one; `null` otherwise. */
  botUsername: z.string().nullable(),
  /** Whether the household's Telegram group is linked. */
  groupLinked: z.boolean(),
  /** Whether the caller has linked their own Telegram account. */
  memberLinked: z.boolean(),
  /** Which kinds of message the house group is sent; all on until an admin switches one off. */
  notifications: telegramNotificationsSchema,
});

export const memberLinkResponseSchema = z.object({
  /** Shown once: only a hash of it is stored. Send it to the bot as `/start <code>`. */
  code: z.string(),
  expiresAt: z.iso.datetime(),
  /** `https://t.me/<bot>?start=<code>`; `null` when the bot's username is not configured. */
  url: z.string().nullable(),
});

export const groupLinkResponseSchema = z.object({
  /** Shown once: only a hash of it is stored. */
  code: z.string(),
  expiresAt: z.iso.datetime(),
  /** What an admin sends in the house group, `/linkgroup <code>`. */
  command: z.string(),
});

export type TelegramStatus = z.infer<typeof telegramStatusSchema>;
export type MemberLinkResponse = z.infer<typeof memberLinkResponseSchema>;
export type GroupLinkResponse = z.infer<typeof groupLinkResponseSchema>;
