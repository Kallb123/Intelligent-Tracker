import type { OccurrenceStatus } from '@tracker/shared';
import { and, asc, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { Database, DbOrTransaction } from './client.js';
import { uniqueViolation } from './errors.js';
import { activity, household, member, notification, occurrence, task } from './schema/index.js';
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
 * code is spent. Returns the household's id, or null for an unknown or expired code, or one
 * refused because another household is already linked to that chat.
 *
 * A group belongs to one household (the bot looks the household up by chat), so while another
 * household is linked to the chat, linking is refused: unlink it there first. The code is spent
 * by that refusal too, in the same statement, because it was just posted in plain text in the
 * group and must not stay valid there. A code that is unknown or expired is refused without
 * touching anything. Linking the household's own chat again is fine. One statement, so two
 * racing redemptions of the same code cannot both succeed. The unique `telegram_group_chat_id`
 * is what holds when two households' codes race for one chat: the loser's statement fails with
 * a unique violation, which is the same refusal (and spends its code in a second statement).
 * `db` must not be a transaction for that last case: a failed statement aborts one.
 */
export async function redeemGroupLinkCode(
  db: Database,
  code: string,
  chatId: number,
  options: { now: Date },
): Promise<string | null> {
  const codeHash = hashToken(code);
  const redeemable = and(
    eq(household.telegramGroupLinkCode, codeHash),
    gt(household.telegramGroupLinkExpiresAt, options.now),
  );
  try {
    const [redeemed] = await db
      .update(household)
      .set({
        // A refused household keeps whatever group (or none) it had.
        telegramGroupChatId: sql`case when exists (
          select 1 from household other
          where other.telegram_group_chat_id = ${chatId} and other.id <> household.id
        ) then household.telegram_group_chat_id else ${chatId} end`,
        telegramGroupLinkCode: null,
        telegramGroupLinkExpiresAt: null,
      })
      .where(redeemable)
      .returning({ id: household.id, chatId: household.telegramGroupChatId });
    return redeemed?.chatId === chatId ? redeemed.id : null;
  } catch (error) {
    if (uniqueViolation(error) === undefined) throw error;
    await db
      .update(household)
      .set({ telegramGroupLinkCode: null, telegramGroupLinkExpiresAt: null })
      .where(redeemable);
    return null;
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

/** What redeeming a member link code did. */
export type MemberLinkResult =
  | ({ status: 'linked' } & LinkedMember)
  | {
      /**
       * The Telegram user is already linked to a different member (`name`, who may be in another
       * household); nothing changed and the code is still valid.
       */
      status: 'already_linked';
      name: string;
    }
  | { status: 'invalid' };

/**
 * Redeems a member link code: the member's `telegram_user_id` becomes `telegramUserId` and the
 * code is spent. The result says whether it `linked`, the code was `invalid` (unknown or
 * expired), or the Telegram user is `already_linked` to a different member.
 *
 * A Telegram user is one member, and the column is unique, so a user who is linked elsewhere is
 * refused instead of being moved, and the code is not spent. Moving them would let anyone who
 * sends a victim a deep link steal their link, possibly from another household; to switch
 * accounts the person disconnects the old one in the app first. Linking the same member again
 * is fine. The member row is locked while this happens, so a racing redemption of the same code
 * cannot also succeed; two racing codes for one Telegram user end in the unique violation,
 * which is the same refusal.
 */
export async function redeemMemberLinkCode(
  db: Database,
  code: string,
  telegramUserId: number,
  options: { now: Date },
): Promise<MemberLinkResult> {
  try {
    return await db.transaction(async (tx): Promise<MemberLinkResult> => {
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
      if (!target) return { status: 'invalid' };

      const [current] = await tx
        .select({ name: member.name })
        .from(member)
        .where(and(eq(member.telegramUserId, telegramUserId), ne(member.id, target.id)));
      if (current) return { status: 'already_linked', name: current.name };

      await tx
        .update(member)
        .set({ telegramUserId, telegramLinkCode: null, telegramLinkExpiresAt: null })
        .where(eq(member.id, target.id));
      return {
        status: 'linked',
        memberId: target.id,
        householdId: target.householdId,
        name: target.name,
      };
    });
  } catch (error) {
    if (uniqueViolation(error) === undefined) throw error;
    const current = await findMemberByTelegramUserId(db, telegramUserId);
    // Gone again already (unlinked in the meantime): nothing was changed, so ask them to retry.
    return current ? { status: 'already_linked', name: current.name } : { status: 'invalid' };
  }
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
 * The group's history, and so the ids of its messages, carries over, so the notifications sent
 * to the old chat are moved to the new one too and their buttons keep working. Returns the
 * household's id, or null when no household was linked to `oldChatId`.
 */
export async function migrateTelegramGroupChat(
  db: Database,
  oldChatId: number,
  newChatId: number,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [migrated] = await tx
      .update(household)
      .set({ telegramGroupChatId: newChatId })
      .where(eq(household.telegramGroupChatId, oldChatId))
      .returning({ id: household.id });
    if (!migrated) return null;
    await tx
      .update(notification)
      .set({ telegramChatId: newChatId })
      .where(
        and(eq(notification.householdId, migrated.id), eq(notification.telegramChatId, oldChatId)),
      );
    return migrated.id;
  });
}

/**
 * The group notifications that were sent as one Telegram message, in the order they were
 * delivered, so the bot can render the message again after one of its buttons is pressed.
 * Message ids are only unique within a chat, so the message is the chat and the id together;
 * without the chat, the messages of two groups (the household was linked to another group, or
 * to a supergroup that reuses ids) would merge.
 */
export async function telegramMessageNotifications(
  db: DbOrTransaction,
  householdId: string,
  telegramChatId: number,
  telegramMessageId: number,
): Promise<Notification[]> {
  return db
    .select()
    .from(notification)
    .where(
      and(
        eq(notification.householdId, householdId),
        eq(notification.channel, 'telegram_group'),
        eq(notification.telegramChatId, telegramChatId),
        eq(notification.telegramMessageId, telegramMessageId),
      ),
    )
    .orderBy(asc(notification.nextAttemptAt), asc(notification.id));
}

/** The household with this id, or null. */
export async function findHouseholdById(
  db: DbOrTransaction,
  householdId: string,
): Promise<Household | null> {
  const [found] = await db.select().from(household).where(eq(household.id, householdId));
  return found ?? null;
}

/** The household's members among `ids` (ids of other households, or unknown ones, are skipped). */
export async function findMembersByIds(
  db: DbOrTransaction,
  householdId: string,
  ids: string[],
): Promise<Member[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(member)
    .where(and(eq(member.householdId, householdId), inArray(member.id, ids)));
}

/** The occurrence actions the activity log attributes to a member (see `occurrence-actions.ts`). */
export const OCCURRENCE_ACTOR_KINDS = ['completed', 'skipped', 'started', 'snoozed'] as const;

export type OccurrenceActorKind = (typeof OCCURRENCE_ACTOR_KINDS)[number];

/** An occurrence as a Telegram group message shows it: where it stands and who got it there. */
export interface OccurrenceState {
  occurrenceId: string;
  status: OccurrenceStatus;
  snoozedUntil: Date | null;
  /**
   * The name of the member who last did each kind of action to it; null when that member has
   * since been deleted. A kind that was never done is absent.
   */
  actors: Partial<Record<OccurrenceActorKind, string | null>>;
}

/**
 * The current state of these occurrences of the household, for rendering a group message again
 * after a button press. Occurrences that no longer exist (or belong to another household) are
 * left out.
 *
 * The actor is kept per kind of action, not only for the latest one, because what a line says
 * depends on the occurrence's state now: a started occurrence that was snoozed and has woken up
 * again is "started by" whoever started it, not by whoever snoozed it.
 */
export async function occurrenceStates(
  db: DbOrTransaction,
  householdId: string,
  occurrenceIds: string[],
): Promise<OccurrenceState[]> {
  if (occurrenceIds.length === 0) return [];
  const rows = await db
    .select({
      occurrenceId: occurrence.id,
      status: occurrence.status,
      snoozedUntil: occurrence.snoozedUntil,
    })
    .from(occurrence)
    .innerJoin(task, eq(task.id, occurrence.taskId))
    .where(and(eq(task.householdId, householdId), inArray(occurrence.id, occurrenceIds)));

  const latest = await db
    .selectDistinctOn([activity.occurrenceId, activity.kind], {
      occurrenceId: activity.occurrenceId,
      kind: activity.kind,
      name: member.name,
    })
    .from(activity)
    .leftJoin(member, eq(member.id, activity.memberId))
    .where(
      and(
        eq(activity.householdId, householdId),
        inArray(activity.occurrenceId, occurrenceIds),
        inArray(
          activity.kind,
          OCCURRENCE_ACTOR_KINDS.map((kind) => `occurrence.${kind}`),
        ),
      ),
    )
    .orderBy(activity.occurrenceId, activity.kind, desc(activity.createdAt), desc(activity.id));

  return rows.map((row) => {
    const actors: OccurrenceState['actors'] = {};
    for (const entry of latest) {
      if (entry.occurrenceId !== row.occurrenceId) continue;
      actors[entry.kind.slice('occurrence.'.length) as OccurrenceActorKind] = entry.name;
    }
    return { ...row, actors };
  });
}
