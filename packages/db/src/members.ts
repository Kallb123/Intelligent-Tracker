import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTransaction } from './client.js';
import { one } from './rows.js';
import { replanRotationsForMember } from './rotation.js';
import { activity, member, type Member } from './schema/index.js';

/** The household's members, by name. */
export async function listMembers(db: DbOrTransaction, householdId: string): Promise<Member[]> {
  return db
    .select()
    .from(member)
    .where(eq(member.householdId, householdId))
    .orderBy(asc(member.name), asc(member.id));
}

/**
 * Sets (or with `null` clears) the date a member is away until, inclusive, and re-plans the open
 * occurrences of the rotations they are in (see `replanRotationsForMember`), logging a
 * `member.away_changed` activity by `actorId`. Setting what is already set changes nothing and
 * logs nothing. Returns the member, or null when `memberId` is not in the household.
 *
 * Run it in a transaction. Who may change whose away date is the caller's decision (the api
 * lets members change their own and admins anyone's; the Telegram bot only the sender's).
 */
export async function setMemberAway(
  db: DbOrTransaction,
  options: {
    householdId: string;
    /** The member making the change, for the activity log. */
    actorId: string;
    memberId: string;
    /** A household-local `YYYY-MM-DD`, or null to clear. */
    awayUntil: string | null;
    now: Date;
  },
): Promise<Member | null> {
  const { householdId, actorId, memberId, awayUntil, now } = options;
  const [target] = await db
    .select()
    .from(member)
    .where(and(eq(member.id, memberId), eq(member.householdId, householdId)))
    // NO KEY UPDATE, so it does not block task edits inserting assignee rows that reference
    // this member (while this holds the member and waits for a task, that would deadlock).
    .for('no key update');
  if (!target) return null;
  if (awayUntil === target.awayUntil) return target;

  const updated = one(
    await db.update(member).set({ awayUntil }).where(eq(member.id, target.id)).returning(),
  );
  await replanRotationsForMember(db, target.id, { now });
  await db.insert(activity).values({
    householdId,
    memberId: actorId,
    kind: 'member.away_changed',
    data: { memberId: target.id, awayUntil },
  });
  return updated;
}
