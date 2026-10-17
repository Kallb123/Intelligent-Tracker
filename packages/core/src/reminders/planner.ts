import type { IANAZone } from 'luxon';
import {
  daysBetween,
  REMINDER_KINDS,
  type OccurrenceStatus,
  type ReminderKind,
  type ReminderProfile,
  type ReminderSlot,
} from '@tracker/shared';
import {
  addDays,
  assertValidDue,
  assertValidInstant,
  fromWall,
  localDateOf,
  localDateOfDue,
  MS_PER_DAY,
  parseLocalDate,
  resolveZone,
} from '../recurrence/calendar.js';
import { assertInteger, RecurrenceError } from '../recurrence/errors.js';
import type { Due, LocalDate } from '../recurrence/types.js';
import { isAwayOn } from '../rotation/index.js';
import { parseTimeOfDay, quietHoursAdjuster } from './slots.js';

/*
 * The reminder planner: given one occurrence, its task and the household settings, it lists every
 * reminder that should fire, as a pure function. The worker re-runs it whenever anything relevant
 * changes (edit, snooze, start, reassign, complete) and replaces the unsent reminders with the
 * result; `key` is stable per occurrence so the outbox can dedupe what was already sent.
 */

// The kinds live in `@tracker/shared` (the db, api and web use them too); re-exported unchanged.
export type { ReminderKind };

/** The order reminders of the same instant are returned in: the order of `REMINDER_KINDS`. */
const KIND_ORDER: readonly ReminderKind[] = REMINDER_KINDS;

export interface PlannedReminder {
  kind: ReminderKind;
  fireAt: Date;
  /** The occurrence's assignee; `null` addresses the whole group. */
  memberId: string | null;
  /**
   * Identifies the reminder within its occurrence and stays the same across re-plans
   * (`heads_up`, `milestone:<id>`, `nudge:<date>`, `due`, `overdue:<date>`), so a dedupe key can
   * be built from it.
   */
  key: string;
  /** Kind `milestone` only. */
  milestoneId?: string;
  milestoneTitle?: string;
  /** Kind `overdue` only: whole local days past the due date. */
  overdueDays?: number;
}

export interface PlanRemindersInput {
  occurrence: {
    due: Due | null;
    status: OccurrenceStatus;
    assigneeId: string | null;
    snoozedUntil: Date | null;
    /** Milestones already ticked off; they get no reminder. */
    completedMilestoneIds?: readonly string[];
  };
  task: {
    leadTimeDays: number | null;
    reminderProfile: ReminderProfile;
    reminderSlot: ReminderSlot;
    /** `HH:MM` or `HH:MM:SS`; required for the `custom_time` slot. */
    reminderCustomTime: string | null;
    /**
     * Shifts the due-day reminder by this many days (`<= 0`): `-1` reminds the evening before,
     * as for putting the bins out. Default 0.
     */
    remindOffsetDays?: number;
    milestones: readonly { id: string; title: string; offsetDaysBeforeDue: number }[];
  };
  /** The occurrence's assignee, for away mode. */
  assignee?: { awayUntil: LocalDate | null } | null;
  household: {
    /** IANA zone name. Defaults to `DEFAULT_TIMEZONE` (Europe/London). */
    timezone?: string;
    /** `HH:MM` or `HH:MM:SS`. */
    morningSlot: string;
    eveningSlot: string;
    /** Wraps midnight when `start` is after `end`; equal times mean no quiet hours. */
    quietHours: { start: string; end: string };
  };
  now: Date;
  /** How far past `now` overdue reminders are planned (the worker re-plans). */
  overdueHorizonDays?: number;
}

/** Overdue reminders are planned this many days past `now` unless the caller says otherwise. */
export const DEFAULT_OVERDUE_HORIZON_DAYS = 14;
const MAX_DAYS = 3650;
/** Standard-profile overdue reminders repeat this often; persistent ones are daily. */
const STANDARD_OVERDUE_INTERVAL_DAYS = 3;

/**
 * An overdue reminder of a `persistent` task that is this many days or more past due is
 * escalated: the group message says it louder (see `isEscalated`).
 */
export const ESCALATE_AFTER_DAYS = 3;

/**
 * Whether an overdue reminder is an escalation ("still not done after N days"). Only the
 * `persistent` profile asks for the louder message (plan 4.3); `standard` keeps its plain,
 * every-3-days reminders. One rule, used where the reminder is queued.
 */
export function isEscalated(profile: ReminderProfile, overdueDays: number): boolean {
  return profile === 'persistent' && overdueDays >= ESCALATE_AFTER_DAYS;
}

/** Nudge positions as fractions of the window between the start day and the due day. */
const NUDGE_FRACTIONS: Record<ReminderProfile, readonly number[]> = {
  silent: [],
  gentle: [],
  standard: [0.5, 0.75, 0.9],
  persistent: [0.25, 0.5, 0.75, 0.9],
};

/** The profile a nudge uses once the occurrence is Started ("you're on it"). */
const TURNED_DOWN: Record<ReminderProfile, ReminderProfile> = {
  silent: 'silent',
  gentle: 'gentle',
  standard: 'gentle',
  persistent: 'standard',
};

function validate(input: PlanRemindersInput): void {
  const { occurrence, task, assignee, now, overdueHorizonDays } = input;
  assertValidInstant(now, 'now');
  if (occurrence.due !== null) assertValidDue(occurrence.due);
  if (occurrence.snoozedUntil !== null) assertValidInstant(occurrence.snoozedUntil, 'snoozedUntil');
  if (assignee?.awayUntil != null) parseLocalDate(assignee.awayUntil);
  if (task.leadTimeDays !== null) assertInteger(task.leadTimeDays, 0, MAX_DAYS, 'leadTimeDays');
  assertInteger(task.remindOffsetDays ?? 0, -MAX_DAYS, 0, 'remindOffsetDays');
  for (const milestone of task.milestones) {
    assertInteger(milestone.offsetDaysBeforeDue, 0, MAX_DAYS, 'offsetDaysBeforeDue');
  }
  if (overdueHorizonDays !== undefined) {
    assertInteger(overdueHorizonDays, 0, MAX_DAYS, 'overdueHorizonDays');
  }
}

/** The task's reminder time of day, in milliseconds after local midnight. */
function slotTimeOfDay(input: PlanRemindersInput): number {
  const { task, household } = input;
  if (task.reminderSlot === 'custom_time') {
    if (task.reminderCustomTime === null) {
      throw new RecurrenceError(
        'invalid_argument',
        'reminderCustomTime is required when reminderSlot is custom_time',
      );
    }
    return parseTimeOfDay(task.reminderCustomTime, 'reminderCustomTime');
  }
  return task.reminderSlot === 'morning'
    ? parseTimeOfDay(household.morningSlot, 'morningSlot')
    : parseTimeOfDay(household.eveningSlot, 'eveningSlot');
}

/** What the rules below need to turn a local day into an instant. */
interface Clock {
  zone: IANAZone;
  /** The task's reminder time of day, after local midnight. */
  slotTime: number;
  /** Moves an instant out of the quiet hours. */
  quietAdjust: (instantMs: number) => number;
}

/** The instant the task's slot time occurs on `day`. */
const slotOn = (clock: Clock, day: LocalDate): number =>
  fromWall(clock.zone, parseLocalDate(day) + clock.slotTime);

/**
 * Plans the reminders of one occurrence, sorted by `fireAt` then kind. Every reminder fires at
 * the task's slot time on its local day (household zone, DST-safe); the rules, in order:
 *
 * - Nothing for a `done` / `skipped` or undated occurrence (the digests cover undated ones) or
 *   a `silent` task (digest only).
 * - The window runs from the start day (`leadTimeDays` before the due day) to the due day; the
 *   due day is the all-day date, or the local date of a timed due. Without a lead time (null or
 *   0) there is no heads-up and no nudges.
 * - `heads_up` on the start day, and one `milestone` per milestone not yet completed on its due
 *   day minus `offsetDaysBeforeDue`; the milestones are kept once the occurrence is Started.
 * - `nudge`s at fractions of the window: `persistent` 25/50/75/90%, `standard` 50/75/90%,
 *   `gentle` none, on day start + round(window days x fraction). Only days strictly between the
 *   start and due days count, and a day that already has another reminder gets no nudge, so
 *   nudges are at least a day apart. A Started occurrence nudges one profile level down
 *   (persistent as standard, standard as gentle).
 * - `due` on the due day plus `remindOffsetDays` (`gentle`, `standard`, `persistent`). For a timed
 *   due whose slot would fall after the due time (once quiet hours are applied), the day before
 *   instead (a 14:00 appointment with the evening slot is reminded at 19:00 the day before), and
 *   no `due` reminder at all when that is still after the due time.
 * - `overdue` from the day after the due day: `standard` then every 3 days, `persistent` daily,
 *   `gentle` never, each carrying `overdueDays`. Only those whose slot is within
 *   `overdueHorizonDays` of `now` (default `DEFAULT_OVERDUE_HORIZON_DAYS`) are planned.
 * - Quiet hours: a time inside them moves to the first household slot at or after their end that
 *   is outside them, or to their end when there is none. This covers custom times, snoozes and
 *   away holds too.
 * - Reminders at or before `now` are dropped first, so a re-plan never resends stale ones and
 *   a hold only ever moves reminders that are still to come.
 * - Holds: a snooze (`snoozedUntil` after `now`) and away mode (the assignee is away today:
 *   until the slot time on the day after `awayUntil`) hold reminders that would fire earlier;
 *   when both apply the later instant wins. Held milestones all move to the hold instant. Of
 *   the other held reminders only the latest, the one nearest the hold, moves there (keeping its
 *   kind and key; an `overdue` one gets `overdueDays` for the hold's day); the rest are dropped, and so is that one when a reminder that was not held
 *   already fires on the hold instant's local day. Nudges are deduplicated again afterwards.
 *
 * Throws `RecurrenceError` for an invalid `now`, due, zone, date or time string, a missing
 * custom time, a positive `remindOffsetDays` or a negative lead time or milestone offset.
 */
export function planReminders(input: PlanRemindersInput): PlannedReminder[] {
  validate(input);
  const { occurrence, task, household, now } = input;
  const { due, status } = occurrence;
  const profile = task.reminderProfile;
  const morning = parseTimeOfDay(household.morningSlot, 'morningSlot');
  const evening = parseTimeOfDay(household.eveningSlot, 'eveningSlot');
  const quiet = {
    start: parseTimeOfDay(household.quietHours.start, 'quietHours.start'),
    end: parseTimeOfDay(household.quietHours.end, 'quietHours.end'),
  };
  const zone = resolveZone(household.timezone);
  const clock: Clock = {
    zone,
    slotTime: slotTimeOfDay(input),
    quietAdjust: quietHoursAdjuster(zone, quiet, [morning, evening]),
  };
  if (due === null || status === 'done' || status === 'skipped' || profile === 'silent') return [];

  const dueDay = localDateOfDue(zone, due);
  const planned = [
    ...prepWindowReminders(input, clock, dueDay),
    ...dueReminder(input, clock, due, dueDay),
    ...overdueReminders(input, clock, dueDay),
  ].map((reminder) => ({
    ...reminder,
    fireAt: new Date(clock.quietAdjust(reminder.fireAt.getTime())),
    memberId: occurrence.assigneeId,
  }));

  // Past reminders go first: they were sent (or are stale) and must not be held or resent, and
  // must not take the place of the upcoming reminder a hold is meant to move.
  const upcoming = sortReminders(planned).filter(
    (reminder) => reminder.fireAt.getTime() > now.getTime(),
  );
  const held = applyHold(zone, dueDay, dedupeNudges(zone, upcoming), holdInstant(input, clock));
  return dedupeNudges(zone, sortReminders(held));
}

const draft = (
  kind: ReminderKind,
  instantMs: number,
  key: string,
  extra: Partial<PlannedReminder> = {},
): PlannedReminder => ({ kind, fireAt: new Date(instantMs), memberId: null, key, ...extra });

/** Heads-up and nudges across the lead-time window, and the milestones. */
function prepWindowReminders(
  input: PlanRemindersInput,
  clock: Clock,
  dueDay: LocalDate,
): PlannedReminder[] {
  const { occurrence, task } = input;
  const reminders: PlannedReminder[] = [];
  const leadDays = task.leadTimeDays ?? 0;
  if (leadDays > 0) {
    const startDay = addDays(dueDay, -leadDays);
    reminders.push(draft('heads_up', slotOn(clock, startDay), 'heads_up'));
    const profile =
      occurrence.status === 'started' ? TURNED_DOWN[task.reminderProfile] : task.reminderProfile;
    for (const fraction of NUDGE_FRACTIONS[profile]) {
      const day = addDays(startDay, Math.round(leadDays * fraction));
      if (day > startDay && day < dueDay) {
        reminders.push(draft('nudge', slotOn(clock, day), `nudge:${day}`));
      }
    }
  }
  const completed = new Set(occurrence.completedMilestoneIds);
  for (const milestone of task.milestones) {
    if (completed.has(milestone.id)) continue;
    const day = addDays(dueDay, -milestone.offsetDaysBeforeDue);
    reminders.push(
      draft('milestone', slotOn(clock, day), `milestone:${milestone.id}`, {
        milestoneId: milestone.id,
        milestoneTitle: milestone.title,
      }),
    );
  }
  return reminders;
}

/** The due-day reminder, which a timed due pulls back to the day before when it comes too late. */
function dueReminder(
  input: PlanRemindersInput,
  clock: Clock,
  due: Due,
  dueDay: LocalDate,
): PlannedReminder[] {
  const day = addDays(dueDay, input.task.remindOffsetDays ?? 0);
  const instantMs = slotOn(clock, day);
  // Judged on the instant the reminder will really fire, after the quiet hours.
  if (due.allDay || clock.quietAdjust(instantMs) <= due.at.getTime())
    return [draft('due', instantMs, 'due')];
  // Too late: the day before, and not at all if quiet hours push that past the due time too.
  const earlierMs = slotOn(clock, addDays(day, -1));
  return clock.quietAdjust(earlierMs) <= due.at.getTime() ? [draft('due', earlierMs, 'due')] : [];
}

/** Overdue reminders from the day after the due day, as far as the horizon. */
function overdueReminders(
  input: PlanRemindersInput,
  clock: Clock,
  dueDay: LocalDate,
): PlannedReminder[] {
  const profile = input.task.reminderProfile;
  if (profile === 'gentle') return [];
  const horizonDays = input.overdueHorizonDays ?? DEFAULT_OVERDUE_HORIZON_DAYS;
  const horizon = input.now.getTime() + horizonDays * MS_PER_DAY;
  const interval = profile === 'persistent' ? 1 : STANDARD_OVERDUE_INTERVAL_DAYS;
  // Skip the days that are certainly past: start at the first reminder, on the grid of 1 + n x
  // interval days from the due day, that is not before the day before `now`'s local day.
  const sinceDue = daysBetween(dueDay, localDateOf(clock.zone, input.now));
  const first = 1 + Math.ceil((sinceDue - 2) / interval) * interval;
  const reminders: PlannedReminder[] = [];
  for (let overdueDays = Math.max(1, first); ; overdueDays += interval) {
    const day = addDays(dueDay, overdueDays);
    const instantMs = slotOn(clock, day);
    if (instantMs > horizon) return reminders;
    reminders.push(draft('overdue', instantMs, `overdue:${day}`, { overdueDays }));
  }
}

/**
 * The instant before which reminders are held, or `null`: the later of the snooze end (when it
 * is still ahead) and the slot time on the day after the assignee's `awayUntil` (when they are
 * away today), each moved out of the quiet hours.
 */
function holdInstant(input: PlanRemindersInput, clock: Clock): number | null {
  const { now, occurrence, assignee } = input;
  const holds: number[] = [];
  const { snoozedUntil } = occurrence;
  if (snoozedUntil !== null && snoozedUntil > now) {
    holds.push(clock.quietAdjust(snoozedUntil.getTime()));
  }
  const awayUntil = assignee?.awayUntil;
  if (awayUntil != null && isAwayOn(awayUntil, localDateOf(clock.zone, now))) {
    holds.push(clock.quietAdjust(slotOn(clock, addDays(awayUntil, 1))));
  }
  return holds.length > 0 ? Math.max(...holds) : null;
}

/**
 * Applies a hold to the reminders (in `fireAt` order, all still to come); see `planReminders`.
 * The latest held non-milestone reminder, the one nearest the hold, moves to it, unless a
 * reminder that was not held already fires that local day.
 */
function applyHold(
  zone: IANAZone,
  dueDay: LocalDate,
  reminders: PlannedReminder[],
  holdMs: number | null,
): PlannedReminder[] {
  if (holdMs === null) return reminders;
  const heldAt = new Date(holdMs);
  const isHeld = (reminder: PlannedReminder): boolean => reminder.fireAt.getTime() < holdMs;
  const held = reminders.filter(isHeld);
  const kept = reminders.filter((reminder) => !isHeld(reminder));
  const holdDay = localDateOf(zone, heldAt);
  const crowded = kept.some((reminder) => localDateOf(zone, reminder.fireAt) === holdDay);
  const survivor = crowded ? undefined : held.findLast((reminder) => reminder.kind !== 'milestone');
  return [
    ...held.filter((reminder) => reminder.kind === 'milestone' || reminder === survivor),
    ...kept,
  ].map((reminder) => {
    if (!isHeld(reminder)) return reminder;
    const moved = { ...reminder, fireAt: heldAt };
    if (reminder.kind !== 'overdue') return moved;
    // An overdue reminder moved to the hold says how overdue it is by then.
    const pastDue = daysBetween(dueDay, holdDay);
    return { ...moved, overdueDays: pastDue };
  });
}

/**
 * Drops a nudge that shares its local day with any other reminder, or with an earlier nudge, so
 * nudges stay at least a day apart and the group stays quiet. Expects `fireAt` order.
 */
function dedupeNudges(zone: IANAZone, reminders: PlannedReminder[]): PlannedReminder[] {
  const dayOf = (reminder: PlannedReminder): LocalDate => localDateOf(zone, reminder.fireAt);
  const taken = new Set(reminders.filter((r) => r.kind !== 'nudge').map(dayOf));
  return reminders.filter((reminder) => {
    if (reminder.kind !== 'nudge') return true;
    const day = dayOf(reminder);
    if (taken.has(day)) return false;
    taken.add(day);
    return true;
  });
}

function sortReminders(reminders: PlannedReminder[]): PlannedReminder[] {
  return reminders.sort(
    (a, b) =>
      a.fireAt.getTime() - b.fireAt.getTime() ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.key.localeCompare(b.key),
  );
}
