import type { Database } from '../client.js';
import { household, type Household } from '../schema/index.js';

/**
 * Creates a household named "Home" with the UK defaults, unless one already exists.
 * No members: accounts are created through the auth flow (PR 5). Returns the new household,
 * or null if one was already there.
 */
export async function seedDemoHousehold(db: Database): Promise<Household | null> {
  const [existing] = await db.select({ id: household.id }).from(household).limit(1);
  if (existing) return null;
  // Every other column takes its UK default from the schema (HOUSEHOLD_DEFAULTS).
  const [created] = await db.insert(household).values({ name: 'Home' }).returning();
  return created ?? null;
}
