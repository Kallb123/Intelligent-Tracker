import { localDateOf, resolveZone } from '../recurrence/calendar.js';
import {
  activeReminderHolds,
  MAX_HEADS_UP_DELAY_DAYS,
  planReminders,
  type PlannedReminder,
  type PlanRemindersInput,
} from './planner.js';

export interface WorkloadPlanInput {
  /** Stable occurrence id; also breaks ties independently of query/input order. */
  id: string;
  householdId: string;
  input: PlanRemindersInput;
}

export interface ReservedHeadsUp {
  householdId: string;
  timezone: string;
  memberId: string | null;
  fireAt: Date;
}

const headsUp = (plan: readonly PlannedReminder[]) => plan.find((r) => r.kind === 'heads_up');

/**
 * Stagger heads-ups per person across the first seven local days of each prep window. Only
 * heads-ups move; milestones, nudges, deadlines, slots and holds retain the single-task rules.
 * Narrow windows go first, then start time and stable id. Choose the least crowded eligible
 * day, preferring the earliest on ties. Broadcast heads-ups count against every person, and
 * consider everyone's load. Existing plans are reservations: adding a task never reshuffles
 * the reminders already promised. Callers persist the chosen heads-up offset with the plan.
 * Inputs must be valid for `planReminders`; failures belong to the caller's per-task handling.
 */
export function smoothReminderPlans(
  entries: readonly WorkloadPlanInput[],
  reserved: readonly ReservedHeadsUp[] = [],
): Map<string, PlannedReminder[]> {
  const loads = new Map<string, Map<string | null, number>>();
  const bucket = (h: string, zone: string | undefined, at: Date): string =>
    JSON.stringify([h, localDateOf(resolveZone(zone), at)]);
  const reserve = (key: string, memberId: string | null): void => {
    const day = loads.get(key) ?? new Map<string | null, number>();
    day.set(memberId, (day.get(memberId) ?? 0) + 1);
    loads.set(key, day);
  };
  for (const r of reserved) reserve(bucket(r.householdId, r.timezone, r.fireAt), r.memberId);

  const candidates = entries.map((entry) => {
    const { input } = entry;
    const original = planReminders(input);
    const head = headsUp(original);
    const plans = [original];
    const { snoozedUntil, awayUntil } = activeReminderHolds(
      input,
      resolveZone(input.household.timezone),
    );
    const held = snoozedUntil !== null || awayUntil !== null;
    if (head && !held) {
      for (let delay = 0; delay <= MAX_HEADS_UP_DELAY_DAYS; delay++) {
        const plan = planReminders({ ...input, headsUpDelayDays: delay });
        const moved = headsUp(plan);
        if (moved && !plans.some((p) => headsUp(p)!.fireAt.getTime() === moved.fireAt.getTime())) {
          plans.push(plan);
        }
      }
    }
    if (head) plans.sort((a, b) => headsUp(a)!.fireAt.getTime() - headsUp(b)!.fireAt.getTime());
    return { entry, plans, head };
  });
  candidates.sort(
    (a, b) =>
      a.plans.length - b.plans.length ||
      (a.head?.fireAt.getTime() ?? 0) - (b.head?.fireAt.getTime() ?? 0) ||
      a.entry.id.localeCompare(b.entry.id),
  );

  const result = new Map<string, PlannedReminder[]>();
  for (const { entry, plans } of candidates) {
    let chosen = plans[0]!;
    let lowest = Infinity;
    for (const plan of plans) {
      const head = headsUp(plan);
      if (!head) continue;
      const key = bucket(entry.householdId, entry.input.household.timezone, head.fireAt);
      const day = loads.get(key);
      const load =
        day === undefined
          ? 0
          : [...day].reduce(
              (total, [person, count]) =>
                total +
                (head.memberId === null || person === null || person === head.memberId ? count : 0),
              0,
            );
      if (load < lowest) {
        chosen = plan;
        lowest = load;
      }
    }
    const head = headsUp(chosen);
    if (head)
      reserve(
        bucket(entry.householdId, entry.input.household.timezone, head.fireAt),
        head.memberId,
      );
    result.set(entry.id, chosen);
  }
  return result;
}
