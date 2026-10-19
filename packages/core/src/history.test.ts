import { describe, expect, it } from 'vitest';
import { MS_PER_DAY } from '@tracker/shared';
import { analyseHistory, type HistoryCompletion, type HistoryInput } from './history.js';

const now = new Date('2026-03-30T12:00:00Z');
const completion = (n: number, overrides: Partial<HistoryCompletion> = {}): HistoryCompletion => ({
  id: String(n),
  dueDate: `2026-03-0${n}`,
  dueAt: null,
  completedAt: new Date(`2026-03-${String(n + 4).padStart(2, '0')}T12:00:00Z`),
  completedBy: 'alex',
  snoozes: 2,
  ...overrides,
});
const base: HistoryInput = {
  now,
  timezone: 'Europe/London',
  task: {
    scheduleKind: 'fixed',
    leadTimeDays: 7,
    reminderSlot: 'morning',
    reminderProfile: 'standard',
    assignmentMode: 'rotation',
    rotationCursor: 0,
  },
  assignees: [
    { id: 'alex', name: 'Alex', awayUntil: null },
    { id: 'sam', name: 'Sam', awayUntil: null },
  ],
  completions: [completion(1), completion(2), completion(3)],
};
const kinds = (input: HistoryInput) => analyseHistory(input).map((s) => s.kind);

describe('history rules (synthetic histories)', () => {
  it('proposes a longer lead and evening slot without mutating the input', () => {
    const before = structuredClone(base);
    expect(analyseHistory(base)).toMatchObject([
      {
        kind: 'lateness',
        patch: { leadTimeDays: 14 },
        message: expect.stringContaining('median 4 days'),
      },
      { kind: 'snoozes', patch: { reminderSlot: 'evening' } },
    ]);
    expect(base).toEqual(before);
  });
  it('requires three completions and ignores future history', () => {
    expect(kinds({ ...base, completions: base.completions.slice(0, 2) })).toEqual([]);
    expect(kinds({ ...base, now: new Date('2026-03-06T00:00:00Z') })).toEqual([]);
  });
  it('does not let old late completions outweigh the last three on-time ones', () => {
    const recent = [4, 5, 6].map((n) =>
      completion(n, { dueDate: `2026-03-${String(n + 4).padStart(2, '0')}`, snoozes: 0 }),
    );
    expect(kinds({ ...base, completions: [...base.completions, ...recent] })).toEqual(['fairness']);
  });
  it('skips undated lateness and requires repeated snoozes on every recent completion', () => {
    expect(
      kinds({
        ...base,
        completions: base.completions.map((c) => ({ ...c, dueDate: null, snoozes: 1 })),
      }),
    ).toEqual([]);
  });
  it('uses the median rather than an outlier and caps the lead at the task limit', () => {
    const completions = [completion(1), completion(2), completion(3, { dueDate: '2025-01-01' })];
    expect(analyseHistory({ ...base, completions })[0]?.patch.leadTimeDays).toBe(14);
    expect(
      analyseHistory({ ...base, task: { ...base.task, leadTimeDays: 3649 } })[0]?.patch
        .leadTimeDays,
    ).toBe(3650);
    expect(kinds({ ...base, task: { ...base.task, leadTimeDays: 3650 } })).toEqual(['snoozes']);
  });
  it('counts all-day lateness in household calendar days across BST', () => {
    const completions = [1, 2, 3].map((n) =>
      completion(n, {
        dueDate: '2026-03-28',
        completedAt: new Date('2026-03-28T23:30:00Z'),
        snoozes: 0,
      }),
    );
    expect(kinds({ ...base, completions })).toEqual([]); // still 28 March in London
    completions.forEach((c) => {
      c.completedAt = new Date('2026-03-29T23:30:00Z');
    });
    expect(analyseHistory({ ...base, completions })[0]?.message).toContain('median 2 days');
  });
  it('uses elapsed days for timed tasks', () => {
    const completions = base.completions.map((c) => ({
      ...c,
      dueDate: null,
      dueAt: new Date(c.completedAt.getTime() - MS_PER_DAY),
    }));
    expect(kinds({ ...base, completions })).toContain('lateness');
    completions[0]!.dueAt = new Date(completions[0]!.completedAt.getTime() - 3_600_000);
    expect(kinds({ ...base, completions })).not.toContain('lateness');
  });
  it('skips one-off and silent reminders and preserves custom/evening slots', () => {
    expect(kinds({ ...base, task: { ...base.task, scheduleKind: 'once' } })).toEqual([]);
    expect(kinds({ ...base, task: { ...base.task, reminderProfile: 'silent' } })).toEqual([]);
    for (const reminderSlot of ['custom_time', 'evening'] as const) {
      expect(kinds({ ...base, task: { ...base.task, reminderSlot } })).toEqual(['lateness']);
    }
  });
  it('suggests the least busy rotation member using actual completers this month', () => {
    const completions = [1, 2, 3, 4, 5].map((n) => completion(n));
    const proposal = analyseHistory({ ...base, completions }).find((s) => s.kind === 'fairness');
    expect(proposal).toMatchObject({
      patch: { rotationCursor: 1 },
      message: expect.stringContaining('Alex did 100%'),
    });
  });
  it('requires five monthly completions, a >=70% share, and a different available next turn', () => {
    expect(kinds({ ...base, completions: [1, 2, 3, 4].map((n) => completion(n)) })).not.toContain(
      'fairness',
    );
    const completions = [1, 2, 3, 4, 5, 6].map((n) =>
      completion(n, { completedBy: n > 3 ? 'sam' : 'alex' }),
    );
    expect(kinds({ ...base, completions })).not.toContain('fairness');
    const skewed = [1, 2, 3, 4, 5].map((n) => completion(n));
    expect(
      kinds({ ...base, completions: skewed, now: new Date('2026-04-01T00:00:00Z') }),
    ).not.toContain('fairness');
    expect(
      kinds({ ...base, completions: skewed, task: { ...base.task, rotationCursor: 1 } }),
    ).not.toContain('fairness');
    expect(
      kinds({
        ...base,
        completions: skewed,
        assignees: base.assignees.map((m) => ({ ...m, awayUntil: '2026-03-30' })),
      }),
    ).not.toContain('fairness');
    expect(
      kinds({ ...base, completions: skewed, task: { ...base.task, assignmentMode: 'fixed' } }),
    ).not.toContain('fairness');
  });
});
