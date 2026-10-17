import { addLocalDays, localToday } from '@tracker/core';
import { MS_PER_DAY, type OccurrenceStatus } from '@tracker/shared';
import { and, asc, eq, gte, lte, or } from 'drizzle-orm';
import type { DbOrTransaction } from './client.js';
import { isPastDue } from './due.js';
import {
  listableOccurrences,
  startingWithin,
  viewCondition,
  viewOrder,
} from './occurrence-views.js';
import { bankHoliday, member, occurrence, task, type Household } from './schema/index.js';
import type { BankHoliday } from './schema/index.js';

/** An occurrence this many days or fewer from its start counts as "starting soon". */
export const STARTING_SOON_DAYS = 3;

/** The most items an agenda holds; the bot's message has to stay within Telegram's limit anyway. */
export const AGENDA_LIMIT = 50;

/** What the bot's digests and commands list: one open occurrence with what a line needs. */
export interface AgendaItem {
  occurrenceId: string;
  taskId: string;
  title: string;
  /** Exactly one of `dueDate` (all-day) and `dueAt` (timed) is set, or neither when undated. */
  dueDate: string | null;
  dueAt: Date | null;
  startAt: Date | null;
  status: OccurrenceStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  effortMinutes: number | null;
  /** Past its due: a timed due before `now`, or an all-day due before today. */
  overdue: boolean;
  /** Its lead time has not begun (`startAt` is ahead) but does within `STARTING_SOON_DAYS`. */
  startingSoon: boolean;
}

export interface Agenda {
  /** The household's local date. */
  today: string;
  /** Overdue first, then by due, undated last (the order of the api's occurrence lists). */
  items: AgendaItem[];
  /** There were more than `AGENDA_LIMIT` jobs, so `items` stops short: the rest are in the app. */
  truncated: boolean;
  holidays: BankHoliday[];
}

export interface AgendaOptions {
  now: Date;
  /** `today`: today's jobs and what starts soon; `week`: also everything due in the next 6 days. */
  view: 'today' | 'week';
  /** Only the jobs assigned to this member. */
  memberId?: string;
}

/**
 * The open jobs a household should look at, and the bank holidays of its region in the same
 * span, for the Telegram digests and commands. It selects the same occurrences as the api's
 * occurrence lists (`listableOccurrences` and the list views), so the bot and the web app agree
 * on what "today" and "the coming week" hold:
 *
 * - `today`: the `today` view (due today or earlier, already within its lead time, or undated)
 *   and what starts within `STARTING_SOON_DAYS`; holidays from today up to a week ahead.
 * - `week`: the `today` view and what is due in the 6 days after today; holidays over the same
 *   7 days.
 *
 * At most `AGENDA_LIMIT` items; they are cut from the end of the list order, so overdue jobs
 * are the last to go, and `truncated` says that some were.
 */
export async function loadAgenda(
  db: DbOrTransaction,
  h: Household,
  options: AgendaOptions,
): Promise<Agenda> {
  const { now, view, memberId } = options;
  const today = localToday(now, h.timezone);
  const last = addLocalDays(today, view === 'today' ? 7 : 6);
  // `days` only matters to the `upcoming` condition, which the week view adds.
  const listOptions = { now, timezone: h.timezone, days: 6 };
  const [rows, holidays] = await Promise.all([
    db
      .select({
        occurrenceId: occurrence.id,
        taskId: occurrence.taskId,
        title: task.title,
        dueDate: occurrence.dueDate,
        dueAt: occurrence.dueAt,
        startAt: occurrence.startAt,
        status: occurrence.status,
        assigneeId: occurrence.assigneeId,
        assigneeName: member.name,
        effortMinutes: task.effortMinutes,
      })
      .from(occurrence)
      .innerJoin(task, eq(task.id, occurrence.taskId))
      .leftJoin(member, eq(member.id, occurrence.assigneeId))
      .where(
        and(
          listableOccurrences(h.id, now),
          memberId ? eq(occurrence.assigneeId, memberId) : undefined,
          or(
            viewCondition('today', listOptions),
            view === 'today'
              ? startingWithin(now, STARTING_SOON_DAYS)
              : viewCondition('upcoming', listOptions),
          ),
        ),
      )
      .orderBy(...viewOrder(listOptions))
      // One more than is kept, to know whether there were more.
      .limit(AGENDA_LIMIT + 1),
    db
      .select()
      .from(bankHoliday)
      .where(
        and(
          eq(bankHoliday.region, h.bankHolidayRegion),
          gte(bankHoliday.date, today),
          lte(bankHoliday.date, last),
        ),
      )
      .orderBy(asc(bankHoliday.date)),
  ]);
  const soon = new Date(now.getTime() + STARTING_SOON_DAYS * MS_PER_DAY);
  const items = rows.slice(0, AGENDA_LIMIT).map((row) => ({
    ...row,
    overdue: isPastDue(row, now, today),
    startingSoon: row.startAt !== null && row.startAt > now && row.startAt <= soon,
  }));
  return { today, items, truncated: rows.length > AGENDA_LIMIT, holidays };
}
