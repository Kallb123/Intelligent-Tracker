import type { ReminderPayload } from '@tracker/shared';
import { formatCalendarDate } from '../format.js';
import { instantToWall } from '../wall-time.js';

/** When the occurrence is due: "1 Nov 2026", or "1 Nov 2026 at 18:30" for a timed one. */
function dueWhen(payload: ReminderPayload, timeZone: string): string {
  if (payload.dueAt) {
    // The date of a timed due is the household's local date, not the browser's.
    const { date, time } = instantToWall(payload.dueAt, timeZone);
    return `${formatCalendarDate(date)} at ${time}`;
  }
  return payload.dueDate ? formatCalendarDate(payload.dueDate) : '';
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * When a `due` reminder says the occurrence is due, relative to the day the reminder fires (in the
 * household's zone): "today", "tomorrow" (a timed due is reminded the evening before when its slot
 * would fall after the due time), or the date when a hold moved the reminder to another day. A
 * timed due also gets its time.
 */
function dueDay(payload: ReminderPayload, timeZone: string): string {
  const timed = payload.dueAt ? instantToWall(payload.dueAt, timeZone) : undefined;
  const date = payload.dueDate ?? timed?.date;
  if (!date) return '';
  const daysAway =
    (Date.parse(`${date}T00:00:00Z`) -
      Date.parse(`${instantToWall(payload.fireAt, timeZone).date}T00:00:00Z`)) /
    MS_PER_DAY;
  const day = daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : formatCalendarDate(date);
  return timed ? `${day} at ${timed.time}` : day;
}

/**
 * What a reminder notification says, in one sentence. `timeZone` is the household's, for the time
 * of a timed due.
 */
export function describeReminder(payload: ReminderPayload, timeZone: string): string {
  const title = payload.taskTitle;
  const when = dueWhen(payload, timeZone);
  switch (payload.kind) {
    case 'heads_up':
      return when ? `Coming up: ${title} (due ${when})` : `Coming up: ${title}`;
    case 'milestone':
      return payload.milestoneTitle ? `${payload.milestoneTitle} — ${title}` : title;
    case 'nudge':
      return when ? `Reminder: ${title} is due ${when}` : `Reminder: ${title}`;
    case 'due':
      return `${title} is due ${dueDay(payload, timeZone)}`;
    case 'overdue': {
      const days = payload.overdueDays;
      if (days === undefined) return `${title} is overdue`;
      return `${title} is ${days} ${days === 1 ? 'day' : 'days'} overdue`;
    }
  }
}
