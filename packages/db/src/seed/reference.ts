import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { bankHoliday, bankHolidaySync } from '../schema/index.js';
import { ENGLAND_AND_WALES_BANK_HOLIDAYS } from './bank-holidays.js';

/** Offline bootstrap only, until the first successful live sync. Idempotent. */
export async function seedReferenceData(db: Database): Promise<{ bankHolidays: number }> {
  const rows = ENGLAND_AND_WALES_BANK_HOLIDAYS.map((row) => ({
    region: row.region,
    date: row.date,
    title: row.title,
  }));
  if (rows.length === 0) return { bankHolidays: 0 };

  return db.transaction(async (tx) => {
    // Same row lock as the live sync: the last successful remote snapshot is authoritative.
    await tx.insert(bankHolidaySync).values({ region: 'england-and-wales' }).onConflictDoNothing();
    const [state] = await tx
      .select()
      .from(bankHolidaySync)
      .where(eq(bankHolidaySync.region, 'england-and-wales'))
      .for('update');
    if (state?.syncedAt) return { bankHolidays: 0 };
    await tx.insert(bankHoliday).values(rows).onConflictDoNothing();
    return { bankHolidays: rows.length };
  });
}
