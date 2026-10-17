import { addLocalDays } from '@tracker/core';
import { type Agenda, type AgendaItem } from '@tracker/db';
import { daysBetween, formatDayHeading, instantToWall } from '@tracker/shared';
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
 * to go. Only jobs are ever left out (and counted): the bank holiday lines, under the jobs in
 * the morning digest and in their day's block in the week, are always kept. An agenda that was
 * itself cut short (`truncated`) says "…and more — see the app" even when the rest fits, and
 * when jobs are also left out here "…and N+ more", as the count is then only a lower bound.
 */

/** A task title is cut to this in a line. */
const MAX_TITLE_LENGTH = 120;
/** A bank holiday's name is cut to this. */
const MAX_HOLIDAY_LENGTH = 60;

/** The tail line for `count` jobs left out here; `truncated`: and more that the agenda cut. */
const more = (count: number, truncated: boolean): string =>
  `…and ${count > 0 ? `${count}${truncated ? '+' : ''} ` : ''}more — see the app`;

/** Text from a person, cut to `max` and with its "@"s defused (see above). */
export function plain(text: string, max: number): string {
  return truncate(text, max).replace(/@/g, '@\u200B');
}

/** The household-local date an item is due on, or null when it is undated. */
function dueDateOf(item: AgendaItem, timeZone: string): string | null {
  return item.dueAt ? instantToWall(item.dueAt, timeZone).date : item.dueDate;
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

/** A line of a section: a job (counted when left out) or a note (never left out). */
interface Row {
  text: string;
  kind: 'item' | 'note';
}

const jobRow = (text: string): Row => ({ text, kind: 'item' });
const noteRow = (text: string): Row => ({ text, kind: 'note' });

/** A titled block of the body: a blank line, the title, then its rows. */
interface Section {
  title: string;
  rows: Row[];
}

/** The section, or no section at all when it has no rows. */
const section = (title: string, rows: Row[]): Section[] => (rows.length ? [{ title, rows }] : []);

const holidayNote = (title: string): string =>
  `${plain(title, MAX_HOLIDAY_LENGTH)}. Bin collection may be a day late.`;

/** `sections` without their last `count` jobs (notes stay, and so does a section left with one). */
function withoutLastJobs(sections: Section[], count: number): Section[] {
  let left = count;
  const kept = sections.map(({ title, rows }) => ({ title, rows: [...rows] }));
  for (const { rows } of kept.toReversed()) {
    for (let i = rows.length - 1; i >= 0 && left > 0; i -= 1) {
      if (rows[i]?.kind === 'item') {
        rows.splice(i, 1);
        left -= 1;
      }
    }
  }
  return kept.filter(({ rows }) => rows.length > 0);
}

/**
 * Joins the heading, the sections and the footer lines, leaving out the last jobs, as many as it
 * takes, when the whole would not fit in a message. `truncated` (the agenda was cut short) always
 * adds the "see the app" tail.
 */
function compose(
  heading: string,
  sections: Section[],
  footer: string[],
  truncated: boolean,
): string {
  const jobs = sections.reduce(
    (n, { rows }) => n + rows.filter((r) => r.kind === 'item').length,
    0,
  );
  const render = (shown: Section[], left: number): string =>
    [
      heading,
      ...shown.flatMap(({ title, rows }) => ['', title, ...rows.map((row) => row.text)]),
      ...(left || truncated ? ['', more(left, truncated)] : []),
      ...(footer.length ? ['', ...footer] : []),
    ].join('\n');
  let text = render(sections, 0);
  for (let left = 1; left <= jobs && text.length > TELEGRAM_MESSAGE_LIMIT; left += 1) {
    text = render(withoutLastJobs(sections, left), left);
  }
  return text;
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
    agenda.truncated,
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
  return compose(heading, [...section('Overdue', overdue), ...blocks], [], agenda.truncated);
}
