import type { DigestKind } from '@tracker/shared';
import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import type { DbOrTransaction } from './client.js';
import { household, telegramDigest, type Household } from './schema/index.js';

/*
 * The log of the scheduled Telegram digests (a morning digest and a Sunday "week ahead" in the
 * house group). The bot decides which digests are due with core's `dueDigests`; the log makes
 * each go out once per household and local date. A digest is claimed before it is sent, so
 * another replica or a repeated tick finds the claim and skips it. This is at-most-once on
 * purpose: a digest only informs, and a duplicate in the group is worse than a missed one.
 */

/** Digest log rows older than this are deleted by `pruneDigests`. */
export const DIGEST_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface DigestKey {
  householdId: string;
  kind: DigestKind;
  /** The household-local date the digest is for. */
  localDate: string;
}

/** The households that have linked a Telegram group, which the digests are sent to. */
export async function linkedHouseholds(db: DbOrTransaction): Promise<Household[]> {
  return db
    .select()
    .from(household)
    .where(isNotNull(household.telegramGroupChatId))
    .orderBy(asc(household.id));
}

/**
 * Claims the right to send a digest: true when this call recorded the claim, false when the
 * digest was already claimed (by an earlier tick or another replica).
 */
export async function claimDigest(
  db: DbOrTransaction,
  options: DigestKey & { now: Date },
): Promise<boolean> {
  const { now, ...key } = options;
  const inserted = await db
    .insert(telegramDigest)
    .values({ ...key, claimedAt: now })
    .onConflictDoNothing()
    .returning({ kind: telegramDigest.kind });
  return inserted.length > 0;
}

function sameDigest(key: DigestKey) {
  return and(
    eq(telegramDigest.householdId, key.householdId),
    eq(telegramDigest.kind, key.kind),
    eq(telegramDigest.localDate, key.localDate),
  );
}

/** Gives a claim back, because the send failed: the next run may claim and send it again. */
export async function releaseDigest(db: DbOrTransaction, key: DigestKey): Promise<void> {
  await db.delete(telegramDigest).where(sameDigest(key));
}

/** Stamps the Telegram message a claimed digest was sent as. */
export async function recordDigestMessage(
  db: DbOrTransaction,
  options: DigestKey & { telegramChatId: number; telegramMessageId: number },
): Promise<void> {
  const { telegramChatId, telegramMessageId, ...key } = options;
  await db.update(telegramDigest).set({ telegramChatId, telegramMessageId }).where(sameDigest(key));
}

/** Deletes the digest log rows claimed more than `DIGEST_LOG_RETENTION_MS` before `now`. */
export async function pruneDigests(db: DbOrTransaction, options: { now: Date }): Promise<number> {
  const deleted = await db
    .delete(telegramDigest)
    .where(lt(telegramDigest.claimedAt, new Date(options.now.getTime() - DIGEST_LOG_RETENTION_MS)))
    .returning({ kind: telegramDigest.kind });
  return deleted.length;
}
