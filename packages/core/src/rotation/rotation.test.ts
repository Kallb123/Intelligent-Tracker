import { describe, expect, it } from 'vitest';
import { advanceCursor, isAwayOn, planRotation, remapCursor } from './index.js';

const A = 'a';
const B = 'b';
const C = 'c';
const slots = (...dates: string[]) => dates.map((date) => ({ date }));
const weekly = slots('2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03');

describe('isAwayOn', () => {
  it('counts the last day as away and the day after as back', () => {
    expect(isAwayOn('2026-07-10', '2026-07-09')).toBe(true);
    expect(isAwayOn('2026-07-10', '2026-07-10')).toBe(true);
    expect(isAwayOn('2026-07-10', '2026-07-11')).toBe(false);
  });

  it('is false when the member has no away date', () => {
    expect(isAwayOn(null, '2026-07-10')).toBe(false);
    expect(isAwayOn(undefined, '2026-07-10')).toBe(false);
  });
});

describe('planRotation', () => {
  it('hands slots out round-robin from the cursor and wraps around', () => {
    const plan = planRotation({ assigneeIds: [A, B, C], cursor: 0, slots: weekly, awayUntil: {} });
    expect(plan.assigneeIds).toEqual([A, B, C, A, B]);
    expect(plan.cursor).toBe(2);

    const shifted = planRotation({
      assigneeIds: [A, B, C],
      cursor: 1,
      slots: weekly,
      awayUntil: {},
    });
    expect(shifted.assigneeIds).toEqual([B, C, A, B, C]);
    expect(shifted.cursor).toBe(0);
  });

  it('skips a member who is away on the due date and carries on after the one who took over', () => {
    const plan = planRotation({
      assigneeIds: [A, B, C],
      cursor: 0,
      slots: weekly,
      // B is away for the second slot only.
      awayUntil: { [B]: '2026-07-13' },
    });
    // Slot 2 would be B's: C takes it, so slot 3 is A's, then B is back.
    expect(plan.assigneeIds).toEqual([A, C, A, B, C]);
    expect(plan.cursor).toBe(0);
  });

  it('honours the boundary: away on the last day, available the day after', () => {
    const plan = planRotation({
      assigneeIds: [A, B],
      cursor: 1,
      slots: slots('2026-07-10', '2026-07-11'),
      awayUntil: { [B]: '2026-07-10' },
    });
    // B is away on the 10th so A takes it; the turn passes to B, who is back on the 11th.
    expect(plan.assigneeIds).toEqual([A, B]);
  });

  it('gives the slot to the member whose turn it is when everyone is away', () => {
    const plan = planRotation({
      assigneeIds: [A, B, C],
      cursor: 1,
      slots: slots('2026-07-06', '2026-07-07'),
      awayUntil: { [A]: '2026-07-31', [B]: '2026-07-31', [C]: '2026-07-31' },
    });
    expect(plan.assigneeIds).toEqual([B, C]);
    expect(plan.cursor).toBe(0);
  });

  it('treats members missing from awayUntil as present', () => {
    const plan = planRotation({
      assigneeIds: [A, B],
      cursor: 0,
      slots: slots('2026-07-06'),
      awayUntil: { [A]: null },
    });
    expect(plan.assigneeIds).toEqual([A]);
  });

  it('assigns nobody for an empty list and keeps the cursor at 0', () => {
    expect(planRotation({ assigneeIds: [], cursor: 3, slots: weekly, awayUntil: {} })).toEqual({
      assigneeIds: [null, null, null, null, null],
      cursor: 0,
    });
  });

  it('gives every slot to a single member', () => {
    const plan = planRotation({ assigneeIds: [A], cursor: 0, slots: weekly, awayUntil: {} });
    expect(plan.assigneeIds).toEqual([A, A, A, A, A]);
    expect(plan.cursor).toBe(0);
  });

  it('wraps a cursor that is out of range or negative', () => {
    const input = { assigneeIds: [A, B, C], slots: slots('2026-07-06'), awayUntil: {} };
    expect(planRotation({ ...input, cursor: 7 }).assigneeIds).toEqual([B]);
    expect(planRotation({ ...input, cursor: -1 }).assigneeIds).toEqual([C]);
  });

  it('moves the cursor not at all when there are no slots', () => {
    const plan = planRotation({ assigneeIds: [A, B], cursor: 5, slots: [], awayUntil: {} });
    expect(plan).toEqual({ assigneeIds: [], cursor: 1 });
  });
});

describe('advanceCursor', () => {
  it('moves to the member after the one whose turn was used', () => {
    expect(advanceCursor([A, B, C], 0, A)).toBe(1);
    expect(advanceCursor([A, B, C], 0, C)).toBe(0);
    // Somebody else's occurrence was handled first: the turn follows the assignee.
    expect(advanceCursor([A, B, C], 0, B)).toBe(2);
  });

  it('moves on by one for a null or unknown assignee', () => {
    expect(advanceCursor([A, B, C], 1, null)).toBe(2);
    expect(advanceCursor([A, B, C], 2, 'gone')).toBe(0);
  });

  it('is 0 for an empty list', () => {
    expect(advanceCursor([], 4, null)).toBe(0);
    expect(advanceCursor([], 4, A)).toBe(0);
  });
});

describe('remapCursor', () => {
  it('keeps pointing at the same member when the list is reordered', () => {
    expect(remapCursor([A, B, C], 1, [C, B, A])).toBe(1);
    expect(remapCursor([A, B, C], 2, [C, A, B])).toBe(0);
    expect(remapCursor([A, B, C], 1, [A, C, B])).toBe(2);
  });

  it('falls back to the start when the member whose turn it was is gone', () => {
    expect(remapCursor([A, B, C], 1, [A, C])).toBe(0);
    expect(remapCursor([A, B, C], 1, [])).toBe(0);
  });

  it('starts at the beginning when there was no list before', () => {
    expect(remapCursor([], 0, [A, B])).toBe(0);
  });

  it('wraps an out of range cursor first', () => {
    expect(remapCursor([A, B], 3, [B, A])).toBe(0);
  });
});
