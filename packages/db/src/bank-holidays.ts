import { RecurrenceError } from '@tracker/core';
import type { BankHolidayEvent } from '@tracker/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Database, DbOrTransaction } from './client.js';
import { rematerialiseTask, type MaterialiseFailure } from './materialise.js';
import { bankHoliday, bankHolidaySync, household, task } from './schema/index.js';

export const BANK_HOLIDAY_SYNC_INTERVAL_MS = 7 * 86_400_000;
export const BANK_HOLIDAY_RETRY_MS = 60 * 60_000;
const REGION = 'england-and-wales';

export async function cachedBankHolidays(
  db: DbOrTransaction,
  region: (typeof bankHoliday.$inferSelect)['region'],
) {
  return db
    .select()
    .from(bankHoliday)
    .where(eq(bankHoliday.region, region))
    .orderBy(asc(bankHoliday.date));
}

/**
 * Weekly cache refresh, serialised across replicas. Failed loads keep the last good cache. When
 * dates change, working-day tasks re-plan the open occurrences those dates can move; a task with a
 * broken schedule keeps its occurrences and is reported in `failures` instead of failing the sync.
 */
export async function syncBankHolidays(
  db: Database,
  options: {
    now: Date;
    load: () => Promise<BankHolidayEvent[]>;
  },
): Promise<{ synced: boolean; error?: string; failures: MaterialiseFailure[] }> {
  return db.transaction(async (tx) => {
    await tx.insert(bankHolidaySync).values({ region: REGION }).onConflictDoNothing();
    const [state] = await tx
      .select()
      .from(bankHolidaySync)
      .where(eq(bankHolidaySync.region, REGION))
      .for('update');
    if (
      !state ||
      (state.syncedAt &&
        options.now.getTime() - state.syncedAt.getTime() < BANK_HOLIDAY_SYNC_INTERVAL_MS) ||
      (state.attemptedAt &&
        options.now.getTime() - state.attemptedAt.getTime() < BANK_HOLIDAY_RETRY_MS)
    )
      return { synced: false, failures: [] };
    await tx
      .update(bankHolidaySync)
      .set({ attemptedAt: options.now })
      .where(eq(bankHolidaySync.region, REGION));
    let events: BankHolidayEvent[];
    try {
      events = await options.load();
      if (!events.length) throw new Error('Bank holiday feed is empty');
      if (new Set(events.map((e) => e.date)).size !== events.length)
        throw new Error('Bank holiday feed contains duplicate dates');
    } catch (error) {
      return {
        synced: false,
        error: error instanceof Error ? error.message : String(error),
        failures: [],
      };
    }
    const oldDates = new Set((await cachedBankHolidays(tx, REGION)).map((e) => e.date));
    const newDates = new Set(events.map((e) => e.date));
    const changed = new Set(
      [...oldDates, ...newDates].filter((date) => oldDates.has(date) !== newDates.has(date)),
    );
    // The response is a complete snapshot of this division. Remove withdrawn dates as well.
    await tx.delete(bankHoliday).where(eq(bankHoliday.region, REGION));
    await tx.insert(bankHoliday).values(
      events.map((e) => ({
        region: REGION as typeof REGION,
        date: e.date,
        title:
          e.title +
          (e.notes && !e.title.toLowerCase().includes(e.notes.toLowerCase())
            ? ` (${e.notes})`
            : ''),
      })),
    );
    const failures: MaterialiseFailure[] = [];
    if (changed.size) {
      const tasks = await tx
        .select({ id: task.id })
        .from(task)
        .innerJoin(household, eq(household.id, task.householdId))
        .where(
          and(
            eq(task.workingDaysOnly, true),
            isNull(task.archivedAt),
            eq(household.bankHolidayRegion, REGION),
          ),
        )
        .orderBy(asc(task.id));
      for (const t of tasks) {
        try {
          // A savepoint, so a broken schedule rolls back only this task's cleared occurrences.
          await tx.transaction(async (sp) => {
            await sp
              .select({ id: task.id })
              .from(task)
              .where(eq(task.id, t.id))
              .for('no key update');
            await rematerialiseTask(sp, t.id, {
              ...options,
              keepDues: true,
              touchingDates: changed,
            });
          });
        } catch (error) {
          if (!(error instanceof RecurrenceError)) throw error;
          failures.push({ taskId: t.id, code: error.code, message: error.message });
        }
      }
    }
    await tx
      .update(bankHolidaySync)
      .set({ syncedAt: options.now })
      .where(eq(bankHolidaySync.region, REGION));
    return { synced: true, failures };
  });
}
