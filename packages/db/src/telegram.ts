import { and, asc, eq, gt, ne, sql } from 'drizzle-orm';
import type { Database, DbOrTransaction } from './client.js';
import { uniqueViolation } from './errors.js';
import { household, member, notification } from './schema/index.js';
import type { Household, Member, Notification } from './schema/index.js';
import { generateToken, hashToken } from './tokens.js';

/*
 * Linking Telegram to the app (docs/PLAN.md 5.1). Two one-time codes, each a `generateToken()`
 * (43 base64url characters, which Telegram accepts as a `/start` deep-link parameter):
 *
 *   - the household's group code, which an admin sends to the bot in the house group as
 *     `/linkgroup <code>`, and which stores that group's chat id on the household;
 *   - a member's code, carried by their `t.me/<bot>?start=<code>` link, which stores their
 *     Telegram user id on the member (so a button press in the group can be attributed).
 *
 * Only the SHA-256 of a code is stored, as with sessions and invite links, so a leaked database
 * cannot be used to link a stranger's group or account. A code works once, for an hour, and a
 * new one replaces the old.
 */

/** How long a link code can be redeemed after it was issued. */
export const TELEGRAM_LINK_CODE_TTL_MS = 60 * 60 * 1000;

export interface TelegramLinkCode {
  /** The code to show the person; it cannot be recovered from the database afterwards. */
  code: string;
  expiresAt: Date;
}

/** The linked member, as the bot needs it to greet them. */
export interface LinkedMember {
  memberId: string;
  householdId: string;
  name: string;
}

/**
 * Issues a one-time code that links a Telegram group to the household, replacing any earlier
 * one. Valid for `TELEGRAM_LINK_CODE_TTL_MS` from `now`.
 */
export async function issueGroupLinkCode(
  db: DbOrTransaction,
  householdId: string,
  options: { now: Date },
): Promise<TelegramLinkCode> {
  const code = generateToken();
  const expiresAt = new Date(options.now.getTime() + TELEGRAM_LINK_CODE_TTL_MS);
  await db
    .update(household)
    .set({ telegramGroupLinkCode: hashToken(code), telegramGroupLinkExpiresAt: expiresAt })
    .where(eq(household.id, householdId));
  return { code, expiresAt };
}

/**
 * Redeems a group link code: the household's `telegram_group_chat_id` becomes `chatId` and the
 * code is spent. Returns the household's id, or null for an unknown or expired code.
 *
 * A group belongs to one household (the bot looks the household up by chat), so the code is
 * refused, and left unspent, while another household is linked to that chat; unlink it there
 * first. Linking the household's own chat again is fine. One statement, so two racing
 * redemptions of the same code cannot both succeed. The unique `telegram_group_chat_id` is what
 * holds when two households' codes race for one chat: the loser's statement fails with a
 * unique violation, which is the same refusal.
 */
export async function redeemGroupLinkCode(
  db: DbOrTransaction,
  code: string,
  chatId: number,
  options: { now: Date },
): Promise<string | null> {
  try {
    const [linked] = await db
      .update(household)
      .set({
        telegramGroupChatId: chatId,
        telegramGroupLinkCode: null,
        telegramGroupLinkExpiresAt: null,
      })
      .where(
        and(
          eq(household.telegramGroupLinkCode, hashToken(code)),
          gt(household.telegramGroupLinkExpiresAt, options.now),
          sql`not exists (
            select 1 from household other
            where other.telegram_group_chat_id = ${chatId} and other.id <> household.id
          )`,
        ),
      )
      .returning({ id: household.id });
    return linked?.id ?? null;
  } catch (error) {
    if (uniqueViolation(error) !== undefined) return null;
    throw error;
  }
}

/** Forgets the household's Telegram group (and any pending group code). */
export async function unlinkGroup(db: DbOrTransaction, householdId: string): Promise<void> {
  await db
    .update(household)
    .set({
      telegramGroupChatId: null,
      telegramGroupLinkCode: null,
      telegramGroupLinkExpiresAt: null,
    })
    .where(eq(household.id, householdId));
}

/**
 * Issues a one-time code that links a Telegram user to the member, replacing any earlier one.
 * Valid for `TELEGRAM_LINK_CODE_TTL_MS` from `now`.
 */
export async function issueMemberLinkCode(
  db: DbOrTransaction,
  memberId: string,
  options: { now: Date },
): Promise<TelegramLinkCode> {
  const code = generateToken();
  const expiresAt = new Date(options.now.getTime() + TELEGRAM_LINK_CODE_TTL_MS);
  await db
    .update(member)
    .set({ telegramLinkCode: hashToken(code), telegramLinkExpiresAt: expiresAt })
    .where(eq(member.id, memberId));
  return { code, expiresAt };
}

/**
 * Redeems a member link code: the member's `telegram_user_id` becomes `telegramUserId` and the
 * code is spent. Returns the member, or null for an unknown or expired code.
 *
 * A Telegram user is one member, and the column is unique, so a user linked to another member
 * is moved: the old link is cleared first. That is what someone wants who redeems a fresh code
 * after being linked to the wrong account. The member row is locked while this happens, so a
 * racing redemption of the same code cannot also succeed.
 */
export async function redeemMemberLinkCode(
  db: Database,
  code: string,
  telegramUserId: number,
  options: { now: Date },
): Promise<LinkedMember | null> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: member.id, householdId: member.householdId, name: member.name })
      .from(member)
      .where(
        and(
          eq(member.telegramLinkCode, hashToken(code)),
          gt(member.telegramLinkExpiresAt, options.now),
        ),
      )
      .for('update');
    if (!target) return null;

    await tx
      .update(member)
      .set({ telegramUserId: null })
      .where(and(eq(member.telegramUserId, telegramUserId), ne(member.id, target.id)));
    await tx
      .update(member)
      .set({ telegramUserId, telegramLinkCode: null, telegramLinkExpiresAt: null })
      .where(eq(member.id, target.id));
    return { memberId: target.id, householdId: target.householdId, name: target.name };
  });
}

/** Forgets the member's Telegram user (and any pending link code). */
export async function unlinkMember(db: DbOrTransaction, memberId: string): Promise<void> {
  await db
    .update(member)
    .set({ telegramUserId: null, telegramLinkCode: null, telegramLinkExpiresAt: null })
    .where(eq(member.id, memberId));
}

/** The member a Telegram user is linked to, or null. */
export async function findMemberByTelegramUserId(
  db: DbOrTransaction,
  telegramUserId: number,
): Promise<Member | null> {
  const [found] = await db.select().from(member).where(eq(member.telegramUserId, telegramUserId));
  return found ?? null;
}

/** The household whose group is the Telegram chat, or null (the bot ignores other chats). */
export async function findHouseholdByTelegramChat(
  db: DbOrTransaction,
  chatId: number,
): Promise<Household | null> {
  const [found] = await db
    .select()
    .from(household)
    .where(eq(household.telegramGroupChatId, chatId));
  return found ?? null;
}

/**
 * Moves a linked group to a new chat id. Telegram gives a group a new id when it is upgraded to
 * a supergroup (and tells the bot with a migration update), after which the old id is dead.
 * Returns the household's id, or null when no household was linked to `oldChatId`.
 */
export async function migrateTelegramGroupChat(
  db: DbOrTransaction,
  oldChatId: number,
  newChatId: number,
): Promise<string | null> {
  const [migrated] = await db
    .update(household)
    .set({ telegramGroupChatId: newChatId })
    .where(eq(household.telegramGroupChatId, oldChatId))
    .returning({ id: household.id });
  return migrated?.id ?? null;
}

/**
 * The group notifications that were sent as one Telegram message, in the order they were
 * delivered, so the bot can render the message again after one of its buttons is pressed.
 */
export async function telegramMessageNotifications(
  db: DbOrTransaction,
  householdId: string,
  telegramMessageId: number,
): Promise<Notification[]> {
  return db
    .select()
    .from(notification)
    .where(
      and(
        eq(notification.householdId, householdId),
        eq(notification.channel, 'telegram_group'),
        eq(notification.telegramMessageId, telegramMessageId),
      ),
    )
    .orderBy(asc(notification.nextAttemptAt), asc(notification.id));
}
