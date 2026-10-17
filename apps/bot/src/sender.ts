import {
  findMemberByTelegramUserId,
  type Database,
  type Household,
  type Member,
} from '@tracker/db';

/** What to tell a Telegram user who is not connected to a member; `then` says what to do next. */
export function linkFirst(then: string): string {
  return (
    'Connect your Telegram first: in the web app, go to Account → Connect Telegram. ' +
    `Then ${then}.`
  );
}

/**
 * The member of `household` that a Telegram user is linked to, or null: not linked at all, or
 * linked to a member of another household (`findMemberByTelegramUserId` looks across all of
 * them, and what someone does in one household's group must never act as a member of another).
 */
export async function memberInHousehold(
  db: Database,
  household: Household,
  telegramUserId: number,
): Promise<Member | null> {
  const found = await findMemberByTelegramUserId(db, telegramUserId);
  return found && found.householdId === household.id ? found : null;
}
