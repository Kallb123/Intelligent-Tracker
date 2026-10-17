import { addLocalDays, localToday } from '../day.js';
import { describeRecurrence } from '../describe.js';
import { parseRecurrence } from '../recurrence-form.js';
import { formatDayHeading, instantToWall } from '@tracker/shared';
import type { QuickAddMember, QuickAddParse } from './types.js';

export interface QuickAddRow {
  label: string;
  value: string;
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The rows of a confirmation card, the same for the web preview and the Telegram `/add` card:
 * When, Repeats, Prep starts, Milestones, Reminder, Working days, For, Template. Rows with
 * nothing to say are left out, except When ("No date"). Dates read like "Sun 1 Nov" (the year is
 * added when it is not this year); a timed task adds "at 09:30" in the household's zone.
 */
export function describeQuickAdd(
  parse: QuickAddParse,
  context: { members: readonly QuickAddMember[]; timezone: string; now: Date },
): QuickAddRow[] {
  const { task, template } = parse;
  const today = localToday(context.now, context.timezone);
  const rows: QuickAddRow[] = [];

  let dueDay: string | null = null;
  let when = 'No date';
  if (task.allDay && task.dueDate) {
    dueDay = task.dueDate;
    when = formatDayHeading(dueDay, today);
  } else if (!task.allDay && task.dueAt) {
    const wall = instantToWall(task.dueAt, context.timezone);
    dueDay = wall.date;
    when = `${formatDayHeading(dueDay, today)} at ${wall.time}`;
  }
  rows.push({ label: 'When', value: when });

  if (task.scheduleKind !== 'once') {
    const state = parseRecurrence({
      scheduleKind: task.scheduleKind,
      rrule: task.rrule ?? null,
      intervalAfterCompletionDays: task.intervalAfterCompletionDays ?? null,
    });
    rows.push({ label: 'Repeats', value: describeRecurrence(state) });
  }

  if (task.leadTimeDays) {
    const start =
      dueDay === null
        ? ''
        : ` (${formatDayHeading(addLocalDays(dueDay, -task.leadTimeDays), today)})`;
    rows.push({
      label: 'Prep starts',
      value: `${plural(task.leadTimeDays, 'day')} before${start}`,
    });
  }

  if (task.milestones.length > 0) {
    const steps = task.milestones.map(
      (m) => `${m.title} (${plural(m.offsetDaysBeforeDue, 'day')} before)`,
    );
    rows.push({ label: 'Milestones', value: steps.join(', ') });
  }

  if (task.remindOffsetDays < 0 || task.reminderSlot !== 'evening') {
    const slot =
      task.reminderSlot === 'custom_time'
        ? `At ${task.reminderCustomTime ?? ''}`.trim()
        : task.reminderSlot === 'morning'
          ? 'Morning'
          : 'Evening';
    const offset =
      task.remindOffsetDays < 0 ? `, ${plural(-task.remindOffsetDays, 'day')} before` : '';
    rows.push({ label: 'Reminder', value: `${slot}${offset}` });
  }

  if (task.workingDaysOnly) rows.push({ label: 'Working days only', value: 'Yes' });

  const names = task.assigneeIds
    .map((id) => context.members.find((m) => m.id === id)?.name)
    .filter((name): name is string => name !== undefined);
  if (names.length > 0) rows.push({ label: 'For', value: names.join(', ') });

  if (template) rows.push({ label: 'Template', value: template.title });
  return rows;
}
