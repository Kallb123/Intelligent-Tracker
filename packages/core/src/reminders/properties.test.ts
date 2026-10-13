import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { localParts } from '../recurrence/test-util.js';
import { planReminders, type PlanRemindersInput } from './index.js';

// Fixed seed: every CI run checks the same cases, and a failure prints its counterexample.
const RUNS = { seed: 20261012, numRuns: 300 };
const LONDON = 'Europe/London';
const DAY = 86_400_000;

const now = fc
  .integer({ min: Date.UTC(2025, 0, 1) / 1000, max: Date.UTC(2028, 0, 1) / 1000 })
  .map((seconds) => new Date(seconds * 1000));

const minuteOfDay = fc.integer({ min: 0, max: 1439 });
const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const time = minuteOfDay.map(clock);

const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A random but valid planner input around a random `now`. */
const planInput = fc
  .record({
    now,
    dueOffsetMinutes: fc.integer({ min: -90 * 1440, max: 200 * 1440 }),
    undated: fc.boolean(),
    allDay: fc.boolean(),
    status: fc.constantFrom('upcoming', 'active', 'started', 'done', 'skipped'),
    profile: fc.constantFrom('silent', 'gentle', 'standard', 'persistent'),
    slot: fc.constantFrom('evening', 'morning', 'custom_time'),
    customTime: time,
    leadTimeDays: fc.option(fc.integer({ min: 0, max: 60 }), { nil: null }),
    remindOffsetDays: fc.integer({ min: -3, max: 0 }),
    milestoneOffsets: fc.array(fc.integer({ min: 0, max: 60 }), { maxLength: 3 }),
    snoozeMinutes: fc.option(fc.integer({ min: -2 * 1440, max: 30 * 1440 }), { nil: null }),
    awayDays: fc.option(fc.integer({ min: -3, max: 30 }), { nil: null }),
    morning: time,
    evening: time,
    quietStart: time,
    quietEnd: time,
    horizon: fc.integer({ min: 0, max: 30 }),
  })
  .map((r): PlanRemindersInput => {
    const dueMs = r.now.getTime() + r.dueOffsetMinutes * 60_000;
    return {
      occurrence: {
        due: r.undated
          ? null
          : r.allDay
            ? { allDay: true, date: dateOf(dueMs) }
            : { allDay: false, at: new Date(dueMs) },
        status: r.status,
        assigneeId: 'member',
        snoozedUntil:
          r.snoozeMinutes === null ? null : new Date(r.now.getTime() + r.snoozeMinutes * 60_000),
      },
      task: {
        leadTimeDays: r.leadTimeDays,
        reminderProfile: r.profile,
        reminderSlot: r.slot,
        reminderCustomTime: r.customTime,
        remindOffsetDays: r.remindOffsetDays,
        milestones: r.milestoneOffsets.map((offsetDaysBeforeDue, i) => ({
          id: `m${i}`,
          title: `Milestone ${i}`,
          offsetDaysBeforeDue,
        })),
      },
      assignee: {
        awayUntil: r.awayDays === null ? null : dateOf(r.now.getTime() + r.awayDays * DAY),
      },
      household: {
        timezone: LONDON,
        morningSlot: r.morning,
        eveningSlot: r.evening,
        quietHours: { start: r.quietStart, end: r.quietEnd },
      },
      now: r.now,
      overdueHorizonDays: r.horizon,
    };
  });

/** Minutes after local midnight in the household zone. */
function localMinutes(instant: Date): number {
  const [hours, minutes] = localParts(instant, LONDON).time.split(':').map(Number);
  return (hours as number) * 60 + (minutes as number);
}

function inQuiet(minutes: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

describe('planReminders properties', () => {
  it('is sorted, entirely in the future, uniquely keyed and deterministic', () => {
    fc.assert(
      fc.property(planInput, (planned) => {
        const reminders = planReminders(planned);
        const times = reminders.map((r) => r.fireAt.getTime());
        expect(times).toEqual([...times].sort((a, b) => a - b));
        expect(times.every((ms) => ms > planned.now.getTime())).toBe(true);
        const keys = reminders.map((r) => r.key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(planReminders(planned)).toEqual(reminders);
      }),
      RUNS,
    );
  });

  it('never fires inside the quiet hours', () => {
    fc.assert(
      fc.property(planInput, (planned) => {
        const { start, end } = planned.household.quietHours;
        for (const reminder of planReminders(planned)) {
          expect(inQuiet(localMinutes(reminder.fireAt), toMinutes(start), toMinutes(end))).toBe(
            false,
          );
        }
      }),
      RUNS,
    );
  });

  it('plans nothing for finished, undated or silent occurrences', () => {
    fc.assert(
      fc.property(planInput, (planned) => {
        const finished = ['done', 'skipped'].includes(planned.occurrence.status);
        if (
          finished ||
          planned.occurrence.due === null ||
          planned.task.reminderProfile === 'silent'
        ) {
          expect(planReminders(planned)).toEqual([]);
        }
      }),
      RUNS,
    );
  });
});
