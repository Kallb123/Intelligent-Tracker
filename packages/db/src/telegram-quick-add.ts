import type { QuickAddTask } from '@tracker/core';
import { MS_PER_DAY } from '@tracker/shared';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { DbOrTransaction } from './client.js';
import { one } from './rows.js';
import { quickAddDraft, type QuickAddDraft } from './schema/index.js';

/*
 * The drafts behind the Telegram `/add` confirmation card. The card's buttons can carry 64 bytes,
 * far too little for a parsed task, so the task waits in `quick_add_draft` under an id the
 * buttons do carry. A draft is single-use: saving and cancelling both go through
 * `takeQuickAddDraft`, whose DELETE ... RETURNING lets exactly one press (say, of a double tap)
 * have it. A draft older than `QUICK_ADD_DRAFT_TTL_MS` no longer counts, whether or not it has
 * been pruned yet.
 */

/** How long a card stays good for. */
export const QUICK_ADD_DRAFT_TTL_MS = MS_PER_DAY;

/** The oldest creation time a draft may have at `now` and still count. */
const oldestLive = (now: Date): Date => new Date(now.getTime() - QUICK_ADD_DRAFT_TTL_MS);

/** Stores what `/add` understood, for `memberId` to save or cancel. */
export async function createQuickAddDraft(
  db: DbOrTransaction,
  options: { householdId: string; memberId: string; task: QuickAddTask; now: Date },
): Promise<QuickAddDraft> {
  const { now, ...values } = options;
  return one(
    await db
      .insert(quickAddDraft)
      .values({ ...values, createdAt: now })
      .returning(),
  );
}

/** The draft of this household that has not expired, or null: gone, expired or someone else's. */
export async function findQuickAddDraft(
  db: DbOrTransaction,
  options: { id: string; householdId: string; now: Date },
): Promise<QuickAddDraft | null> {
  const [row] = await db
    .select()
    .from(quickAddDraft)
    .where(
      and(
        eq(quickAddDraft.id, options.id),
        eq(quickAddDraft.householdId, options.householdId),
        gt(quickAddDraft.createdAt, oldestLive(options.now)),
      ),
    );
  return row ?? null;
}

/**
 * Deletes and returns the draft, or null when it is gone or has expired. Of any number of
 * concurrent calls for one draft, exactly one gets it. Run inside the transaction that saves the
 * task, a failed save puts the draft back.
 */
export async function takeQuickAddDraft(
  db: DbOrTransaction,
  options: { id: string; householdId: string; now: Date },
): Promise<QuickAddDraft | null> {
  const [row] = await db
    .delete(quickAddDraft)
    .where(
      and(
        eq(quickAddDraft.id, options.id),
        eq(quickAddDraft.householdId, options.householdId),
        gt(quickAddDraft.createdAt, oldestLive(options.now)),
      ),
    )
    .returning();
  return row ?? null;
}

/** Deletes the drafts that have expired, and returns how many. */
export async function pruneQuickAddDrafts(
  db: DbOrTransaction,
  options: { now: Date },
): Promise<number> {
  const deleted = await db
    .delete(quickAddDraft)
    .where(lt(quickAddDraft.createdAt, oldestLive(options.now)))
    .returning({ id: quickAddDraft.id });
  return deleted.length;
}
