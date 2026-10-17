import { addLocalDays, localToday } from '@tracker/core';
import { OPEN_OCCURRENCE_STATUSES } from '@tracker/shared';
import { and, asc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import type { DbOrTransaction } from './client.js';
import { dueInstant } from './due.js';
import { bankHoliday, occurrence, task, type Household } from './schema/index.js';

/** Today's open jobs and the coming week's cached holidays for the household's region. */
export async function loadDigest(db: DbOrTransaction, h: Household, now: Date) {
  const today = localToday(now, h.timezone);
  const [jobs, holidays] = await Promise.all([
    db
      .select({ title: task.title, dueDate: occurrence.dueDate, dueAt: occurrence.dueAt })
      .from(occurrence)
      .innerJoin(task, eq(task.id, occurrence.taskId))
      .where(
        and(
          eq(task.householdId, h.id),
          isNull(task.archivedAt),
          inArray(occurrence.status, [...OPEN_OCCURRENCE_STATUSES]),
          or(
            eq(occurrence.status, 'active'),
            eq(occurrence.status, 'started'),
            lte(dueInstant(h.timezone), now.toISOString()),
          ),
        ),
      )
      .orderBy(asc(task.title))
      .limit(15),
    db
      .select()
      .from(bankHoliday)
      .where(
        and(
          eq(bankHoliday.region, h.bankHolidayRegion),
          gte(bankHoliday.date, today),
          lte(bankHoliday.date, addLocalDays(today, 7)),
        ),
      )
      .orderBy(asc(bankHoliday.date)),
  ]);
  return { today, jobs, holidays };
}
