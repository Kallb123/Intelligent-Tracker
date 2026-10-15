import { z } from 'zod';

/** Request and response shapes of the Telegram linking API (docs/PLAN.md 5.1). */

export const telegramStatusSchema = z.object({
  /** The bot's username (no `@`) when the deployment configured one; `null` otherwise. */
  botUsername: z.string().nullable(),
  /** Whether the household's Telegram group is linked. */
  groupLinked: z.boolean(),
  /** Whether the caller has linked their own Telegram account. */
  memberLinked: z.boolean(),
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
