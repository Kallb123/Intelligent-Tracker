import { addLocalDays } from '@tracker/core';
import { type Agenda, type AgendaItem } from '@tracker/db';
import { formatDayHeading, instantToWall } from '@tracker/shared';
import { MAX_NAME_LENGTH, TELEGRAM_MESSAGE_LIMIT, truncate } from './render.js';

/*
 * The text of the morning digest, the Sunday "week ahead" and the /today, /week, /mine and
 * /digest replies, as pure functions of an agenda (`loadAgenda`). One implementation, so a
 * command shows exactly what the scheduled digest would.
 *
 * Plain text, sent without a parse mode: a task title or a name cannot inject markup. Nothing
 * here may ping anyone either (a digest informs; the reminders are what notify), and Telegram
 * turns a plain "@name" into a mention, so `plain` defuses every "@". An agenda with no jobs
 * renders as null: the scheduled digest stays quiet and a command says there is nothing on.
 *
 * The whole message stays within Telegram's limit. When the jobs do not fit, the last ones are
 * left out for "…and N more — see the app", so the overdue ones, which come first, are the last
 * to go. The bank holiday lines under the jobs are always kept.
 */

/** A task title is cut to this in a line. */
const MAX_TITLE_LENGTH = 120;
/** A bank holiday's name is cut to this. */
const MAX_HOLIDAY_LENGTH = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

const more = (count: number): string => `…and ${count} more — see the app`;

/** Text from a person, cut to `max` and with its "@"s defused (see above). */
function plain(text: string, max: number): string {
  return truncate(text, max).replace(/@/g, '@​');
}

/** The household-local date an item is due on, or null when it is undated. */
function dueDateOf(item: AgendaItem, timeZone: string): string | null {
  return item.dueAt ? instantToWall(item.dueAt, timeZone).date : item.dueDate;
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

interface Context {
  today: string;
  timeZone: string;
}

/** How long it is overdue, or when it was due earlier today. */
function overdueText(item: AgendaItem, { today, timeZone }: Context): string {
  const due = dueDateOf(item, timeZone);
  const days = due ? daysBetween(due, today) : 0;
  if (days === 0 && item.dueAt) return `was due ${instantToWall(item.dueAt, timeZone).time}`;
  return `${days} ${days === 1 ? 'day' : 'days'} overdue`;
}

/** The due time of a timed job, or the date when it is not due on the day it is listed under. */
function dueText(item: AgendaItem, listedOn: string, { today, timeZone }: Context): string {
  if (item.dueAt) {
    const { date, time } = instantToWall(item.dueAt, timeZone);
    return date === listedOn ? `due ${time}` : `due ${formatDayHeading(date, today)} ${time}`;
  }
  return item.dueDate && item.dueDate !== listedOn
    ? `due ${formatDayHeading(item.dueDate, today)}`
    : '';
}

/** "starts Thu": the lead time of the job has not begun yet. */
function startsText(item: AgendaItem, { today, timeZone }: Context): string {
  const date = instantToWall(item.startAt as Date, timeZone).date;
  return date === today ? 'starts today' : `starts ${formatDayHeading(date).slice(0, 3)}`;
}

/** `• Title — Name (when)`. */
function itemLine(item: AgendaItem, when: string): string {
  const who = item.assigneeName ? plain(item.assigneeName, MAX_NAME_LENGTH) : 'Anyone';
  return `• ${plain(item.title, MAX_TITLE_LENGTH)} — ${who}${when ? ` (${when})` : ''}`;
}

/** A line of the body: a job (counted when left out), a note, or the frame around them. */
interface Row {
  text: string;
  kind: 'item' | 'note' | 'frame';
}

const jobRow = (text: string): Row => ({ text, kind: 'item' });
const noteRow = (text: string): Row => ({ text, kind: 'note' });
const frameRow = (text: string): Row => ({ text, kind: 'frame' });

/** A titled section: a blank line, the title, then its rows. Nothing when it has no rows. */
function section(title: string, rows: Row[]): Row[] {
  return rows.length === 0 ? [] : [frameRow(''), frameRow(title), ...rows];
}

const holidayNote = (title: string): string =>
  `${plain(title, MAX_HOLIDAY_LENGTH)}. Bin collection may be a day late.`;

/**
 * Joins the heading, the body rows and the footer lines, leaving out the last body rows when the
 * whole would not fit in a message.
 */
function compose(heading: string, body: Row[], footer: string[]): string {
  const foot = footer.length ? ['', ...footer] : [];
  const join = (rows: string[]): string => [heading, ...rows].join('\n');
  const all = body.map((row) => row.text);
  const whole = join([...all, ...foot]);
  if (whole.length <= TELEGRAM_MESSAGE_LIMIT) return whole;

  // The room left for the body, once the footer and the longest possible "…and N more" are in.
  const room = TELEGRAM_MESSAGE_LIMIT - join([...foot, '', more(body.length)]).length;
  let keep = 0;
  while (keep < body.length && join(all.slice(0, keep + 1)).length <= room) keep += 1;
  // Never end on a section title or a blank line.
  while (keep > 0 && body[keep - 1]?.kind === 'frame') keep -= 1;
  const left = body.slice(keep).filter((row) => row.kind === 'item').length;
  return join([...all.slice(0, keep), ...(left ? ['', more(left)] : []), ...foot]);
}

/**
 * The morning digest, `/today` and `/digest`: what is overdue, what is on today and what
 * starts soon, then the bank holidays coming up. "Today" also holds jobs with no date and jobs
 * whose lead time has begun, which are there to be done today, whenever they are due.
 */
export function renderMorningDigest(agenda: Agenda, timeZone: string): string | null {
  if (agenda.items.length === 0) return null;
  const { today } = agenda;
  const context = { today, timeZone };
  const overdue: Row[] = [];
  const onToday: Row[] = [];
  const soon: Row[] = [];
  for (const job of agenda.items) {
    if (job.overdue) overdue.push(jobRow(itemLine(job, overdueText(job, context))));
    else if (dueDateOf(job, timeZone) === today) {
      onToday.push(jobRow(itemLine(job, dueText(job, today, context))));
    } else if (job.startingSoon) soon.push(jobRow(itemLine(job, startsText(job, context))));
    else onToday.push(jobRow(itemLine(job, dueText(job, today, context))));
  }
  return compose(
    `☀️ ${formatDayHeading(today)}`,
    [
      ...section('Overdue', overdue),
      ...section('Today', onToday),
      ...section('Starting soon', soon),
    ],
    agenda.holidays.map(
      (holiday) =>
        `Bank holiday ${formatDayHeading(holiday.date, today)}: ${holidayNote(holiday.title)}`,
    ),
  );
}

/**
 * The day a job is listed under in the week: its due day, else the day it starts, else today
 * (undated jobs, and jobs whose lead time has begun but which are due after this week).
 */
function weekDayOf(
  job: AgendaItem,
  { today, timeZone }: Context,
): { day: string; byStart: boolean } {
  const last = addLocalDays(today, 6);
  const due = dueDateOf(job, timeZone);
  if (due !== null && due <= last) return { day: due, byStart: false };
  const start = job.startAt ? instantToWall(job.startAt, timeZone).date : null;
  if (start !== null && start > today && start <= last) return { day: start, byStart: true };
  return { day: today, byStart: false };
}

/**
 * The Sunday "week ahead", `/week` and `/mine`: the overdue jobs first, then a block for each
 * day of the week that has jobs or a bank holiday. `heading` is the first line.
 */
export function renderWeekAhead(
  agenda: Agenda,
  timeZone: string,
  heading = '📅 Week ahead',
): string | null {
  if (agenda.items.length === 0) return null;
  const { today } = agenda;
  const context = { today, timeZone };
  const overdue: Row[] = [];
  const days = new Map<string, Row[]>();
  const rowsOf = (day: string): Row[] => {
    const rows = days.get(day) ?? [];
    days.set(day, rows);
    return rows;
  };
  for (const job of agenda.items) {
    if (job.overdue) {
      overdue.push(jobRow(itemLine(job, overdueText(job, context))));
      continue;
    }
    const { day, byStart } = weekDayOf(job, context);
    // Listed on the day it starts, the heading says which day that is.
    const when = byStart ? 'can start' : dueText(job, day, context);
    rowsOf(day).push(jobRow(itemLine(job, when)));
  }
  for (const holiday of agenda.holidays) {
    rowsOf(holiday.date).push(noteRow(`Bank holiday: ${holidayNote(holiday.title)}`));
  }
  const blocks = [...days.keys()]
    .sort()
    .flatMap((day) => section(formatDayHeading(day, today), days.get(day) as Row[]));
  return compose(heading, [...section('Overdue', overdue), ...blocks], []);
}
