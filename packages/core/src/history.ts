import { daysBetween, MS_PER_DAY, type ReminderSlot, type SuggestionKind } from '@tracker/shared';
import { localToday } from './day.js';
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
  task: {
    scheduleKind: string;
    leadTimeDays: number | null;
    reminderSlot: ReminderSlot;
    reminderProfile: string;
    assignmentMode: string;
    rotationCursor: number;
  };
  assignees: readonly { id: string; name: string; awayUntil: string | null }[];
  completions: readonly HistoryCompletion[];
}

export interface HistoryProposal {
  kind: SuggestionKind;
  message: string;
  /** Evidence, independent of task settings, so resolving it suppresses this history sample. */
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
  const recent = completions.slice(0, 3);
  const proposals: HistoryProposal[] = [];
  if (recent.length === 3 && task.reminderProfile !== 'silent') {
    const offsets = recent.map((c) => lateness(c, timezone));
    if (offsets.every((days) => days !== null && days >= 1)) {
      const median = offsets.map((d) => d as number).sort((a, b) => a - b)[1] as number;
      const lead = Math.min(3650, (task.leadTimeDays ?? 0) + Math.ceil(median / 7) * 7);
      if (lead > (task.leadTimeDays ?? 0)) {
        proposals.push({
          kind: 'lateness',
          message: `The last 3 completions were late (median ${Math.round(median)} days). Start reminders ${lead} days before the due date?`,
          evidence: recent.map((c) => c.id),
          patch: { leadTimeDays: lead },
        });
      }
    }
    if (task.reminderSlot === 'morning' && recent.every((c) => c.snoozes >= 2)) {
      proposals.push({
        kind: 'snoozes',
        message:
          'Each of the last 3 completions was snoozed at least twice. Move reminders to the household evening slot?',
        evidence: recent.map((c) => `${c.id}:${c.snoozes}`),
        patch: { reminderSlot: 'evening' },
      });
    }
  }

  const today = localToday(now, timezone);
  const month = today.slice(0, 7);
  const monthly = completions.filter((c) => localToday(c.completedAt, timezone).startsWith(month));
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
