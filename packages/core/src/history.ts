import { daysBetween, MS_PER_DAY, type TaskDto, type SuggestionKind } from '@tracker/shared';
import { localToday } from './day.js';
import { parseRRule, RRule } from './recurrence/rrule-parse.js';
import { isAwayOn } from './rotation/index.js';

/** Completed occurrences, newest first. The database supplies at most 20 per series. */
export interface HistoryCompletion {
  id: string;
  dueDate: string | null;
  dueAt: Date | null;
  completedAt: Date;
  completedBy: string | null;
  snoozes: number;
}

export interface HistoryInput {
  now: Date;
  timezone: string;
  task: Pick<
    TaskDto,
    | 'scheduleKind'
    | 'leadTimeDays'
    | 'reminderSlot'
    | 'reminderProfile'
    | 'assignmentMode'
    | 'rrule'
    | 'intervalAfterCompletionDays'
    | 'workingDaysOnly'
  > & {
    rotationCursor: number;
  };
  assignees: readonly { id: string; name: string; awayUntil: string | null }[];
  completions: readonly HistoryCompletion[];
  /** Each kind needs entirely new completion evidence after its last accept OR dismiss. */
  decidedAt?: Partial<Record<SuggestionKind, Date>>;
}

export interface HistoryProposal {
  kind: SuggestionKind;
  message: string;
  /** Evidence, independent of task settings, for card identity and the decision audit. */
  evidence: string[];
  patch: { leadTimeDays?: number; reminderSlot?: 'evening'; rotationCursor?: number };
}

/** Calendar days for all-day dues (including DST), elapsed days for timed dues. */
function lateness(row: HistoryCompletion, timezone: string): number | null {
  if (row.dueDate !== null) {
    return daysBetween(row.dueDate, localToday(row.completedAt, timezone));
  }
  return row.dueAt === null ? null : (row.completedAt.getTime() - row.dueAt.getTime()) / MS_PER_DAY;
}

/**
 * A conservative lower bound, not an average: selectors can cluster dates within a cycle.
 * Only suggest leads where a safe gap is known. Working-day shifts and complex selectors
 * may bring dues closer together, so those patterns get no lateness suggestion.
 */
function minimumCycleDays(task: HistoryInput['task']): number {
  if (task.workingDaysOnly) return 0;
  if (task.scheduleKind === 'after_completion') return task.intervalAfterCompletionDays ?? 0;
  if (task.scheduleKind !== 'fixed' || task.rrule === null) return 0;
  const { options } = parseRRule(task.rrule);
  const interval = options.interval ?? 1;
  // The validated parser always produces arrays for selectors.
  const weekdays = Array.isArray(options.byweekday) ? options.byweekday : [];
  const monthDays = Array.isArray(options.bymonthday) ? options.bymonthday : [];
  const months = Array.isArray(options.bymonth) ? options.bymonth : [];
  const positions = Array.isArray(options.bysetpos) ? options.bysetpos : [];
  if (options.freq === RRule.DAILY) return interval;
  if (options.freq === RRule.WEEKLY) {
    // Without an explicit weekday, BYMONTHDAY replaces the usual DTSTART weekday default.
    return weekdays.length === 1 || (weekdays.length === 0 && monthDays.length === 0)
      ? 7 * interval
      : 0;
  }
  const ordinalWeekday =
    weekdays.length === 1 && typeof weekdays[0] === 'object' && weekdays[0].n != null;
  const oneMonthDay = monthDays.length === 1 || (monthDays.length === 0 && weekdays.length === 0);
  if (options.freq === RRule.MONTHLY) {
    if (oneMonthDay || (monthDays.length === 0 && ordinalWeekday)) return 28 * interval;
    // A fixed nth match among ordinary weekdays moves by at most six calendar days.
    if (
      monthDays.length === 0 &&
      positions.length === 1 &&
      weekdays.length > 0 &&
      weekdays.every((d) => typeof d === 'object' && d.n == null)
    )
      return 28 * interval - 6;
  }
  if (options.freq === RRule.YEARLY && months.length <= 1) {
    // YEARLY + BYMONTHDAY without BYMONTH expands into every month of the year.
    if (oneMonthDay && (monthDays.length === 0 || months.length === 1)) return 365 * interval;
    if (months.length === 1 && monthDays.length === 0 && ordinalWeekday) return 365 * interval - 6;
  }
  return 0;
}

/**
 * Conservative, opt-in rules: three late completions, three repeatedly snoozed completions,
 * or at least five recent rotation completions this month with one person doing >=70%.
 * No I/O or mutation. Skips one-offs and silent reminders; fairness counts actual completers.
 */
export function analyseHistory(input: HistoryInput): HistoryProposal[] {
  const { task, timezone, now, assignees } = input;
  if (task.scheduleKind === 'once') return [];
  const completions = input.completions
    .filter((c) => c.completedAt <= now)
    .toSorted(
      (a, b) => b.completedAt.getTime() - a.completedAt.getTime() || a.id.localeCompare(b.id),
    )
    .slice(0, 20);
  const sinceDecision = (kind: SuggestionKind) =>
    completions.filter(
      (c) => input.decidedAt?.[kind] === undefined || c.completedAt > input.decidedAt[kind]!,
    );
  const recent = sinceDecision('lateness').slice(0, 3);
  const proposals: HistoryProposal[] = [];
  if (recent.length === 3 && task.reminderProfile !== 'silent') {
    const offsets = recent.map((c) => lateness(c, timezone));
    if (offsets.every((days) => days !== null && days >= 1)) {
      const median = offsets.map((d) => d as number).sort((a, b) => a - b)[1] as number;
      const cycle = minimumCycleDays(task);
      const lead = Math.min(3650, cycle - 1, (task.leadTimeDays ?? 0) + Math.ceil(median / 7) * 7);
      if (cycle >= 14 && lead > (task.leadTimeDays ?? 0)) {
        const rounded = Math.round(median);
        proposals.push({
          kind: 'lateness',
          message: `The last 3 completions were late (median ${rounded} ${rounded === 1 ? 'day' : 'days'}). Start reminders ${lead} days before the due date?`,
          evidence: recent.map((c) => c.id),
          patch: { leadTimeDays: lead },
        });
      }
    }
  }
  const snoozed = sinceDecision('snoozes').slice(0, 3);
  if (
    task.reminderProfile !== 'silent' &&
    task.reminderSlot === 'morning' &&
    snoozed.length === 3 &&
    snoozed.every((c) => c.snoozes >= 2)
  ) {
    proposals.push({
      kind: 'snoozes',
      message:
        'Each of the last 3 completions was snoozed at least twice. Move reminders to the household evening slot?',
      evidence: snoozed.map((c) => `${c.id}:${c.snoozes}`),
      patch: { reminderSlot: 'evening' },
    });
  }

  const today = localToday(now, timezone);
  const month = today.slice(0, 7);
  const monthly = sinceDecision('fairness').filter((c) =>
    localToday(c.completedAt, timezone).startsWith(month),
  );
  // Removed/non-participating members are excluded from the comparison, but not its denominator.
  const counts = assignees.map((m) => ({
    ...m,
    count: monthly.filter((c) => c.completedBy === m.id).length,
  }));
  const busiest = counts.toSorted((a, b) => b.count - a.count)[0];
  const target = counts
    .filter((m) => !isAwayOn(m.awayUntil, today))
    .toSorted((a, b) => a.count - b.count)[0];
  if (
    task.assignmentMode === 'rotation' &&
    assignees.length >= 2 &&
    monthly.length >= 5 &&
    busiest &&
    target &&
    busiest.count / monthly.length >= 0.7 &&
    target.count < busiest.count &&
    assignees[task.rotationCursor % assignees.length]?.id !== target.id
  ) {
    proposals.push({
      kind: 'fairness',
      message: `${busiest.name} did ${Math.round((100 * busiest.count) / monthly.length)}% of this series' last ${monthly.length} completions this month. Give ${target.name} the next rotation turn? Started jobs stay with their current assignee.`,
      evidence: [month, ...monthly.map((c) => `${c.id}:${c.completedBy ?? ''}`)],
      patch: { rotationCursor: assignees.findIndex((m) => m.id === target.id) },
    });
  }
  return proposals;
}
