import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { bankHoliday } from '../schema/index.js';
import { ENGLAND_AND_WALES_BANK_HOLIDAYS } from './bank-holidays.js';

/** Upserts reference data shared by every household. Idempotent. */
export async function seedReferenceData(db: Database): Promise<{ bankHolidays: number }> {
  const rows = ENGLAND_AND_WALES_BANK_HOLIDAYS.map((row) => ({
    region: row.region,
    date: row.date,
    title: row.title,
  }));
  if (rows.length === 0) return { bankHolidays: 0 };

  await db
    .insert(bankHoliday)
    .values(rows)
    .onConflictDoUpdate({
      target: [bankHoliday.region, bankHoliday.date],
      set: { title: sql`excluded.title` },
    });
  return { bankHolidays: rows.length };
}
