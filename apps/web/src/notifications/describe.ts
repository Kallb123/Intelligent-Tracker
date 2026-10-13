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
      return payload.dueAt
        ? `${title} is due today at ${instantToWall(payload.dueAt, timeZone).time}`
        : `${title} is due today`;
    case 'overdue': {
      const days = payload.overdueDays;
      if (days === undefined) return `${title} is overdue`;
      return `${title} is ${days} ${days === 1 ? 'day' : 'days'} overdue`;
    }
  }
}
