import { SNOOZE_OPTION_KEYS } from '@tracker/core';
import { describe, expect, it } from 'vitest';
import {
  decodeCallback,
  decodeQuickAddCallback,
  encodeCallback,
  encodeQuickAddCallback,
  QUICK_ADD_CALLBACK,
  type CallbackAction,
  type QuickAddCallback,
} from './callback-data.js';

const ID = '3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c';
const MILESTONE_ID = 'c0ffee00-1234-4abc-9def-0123456789ab';

const actions: CallbackAction[] = [
  { type: 'complete', occurrenceId: ID },
  { type: 'start', occurrenceId: ID },
  { type: 'skip', occurrenceId: ID },
  { type: 'snoozeMenu', occurrenceId: ID },
  { type: 'back', occurrenceId: ID },
  { type: 'milestone', occurrenceId: ID, milestoneId: MILESTONE_ID },
  ...SNOOZE_OPTION_KEYS.map((key) => ({ type: 'snooze' as const, key, occurrenceId: ID })),
];

describe('callback data', () => {
  it.each(actions)('round-trips %j within Telegram limit of 64 bytes', (action) => {
    const data = encodeCallback(action);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(decodeCallback(data)).toEqual(action);
  });

  it('encodes compactly', () => {
    expect(encodeCallback({ type: 'complete', occurrenceId: ID })).toBe(`d:${ID}`);
    expect(encodeCallback({ type: 'snooze', key: '3d', occurrenceId: ID })).toBe(`n:3d:${ID}`);
  });

  it('packs the two ids of a milestone tick into 47 bytes', () => {
    const data = encodeCallback({ type: 'milestone', occurrenceId: ID, milestoneId: MILESTONE_ID });
    expect(data).toMatch(/^m:[\w-]{22}:[\w-]{22}$/);
    expect(Buffer.byteLength(data)).toBe(47);
  });

  it.each([
    '',
    'd',
    'd:',
    'd:not-a-uuid',
    `q:${ID}`,
    `d:extra:${ID}`,
    `n:${ID}`,
    `n:never:${ID}`,
    `x:tonight:${ID}`,
    ID,
    'm',
    'm:AAAAAAAAAAAAAAAAAAAAAA',
    `m:${ID}:${MILESTONE_ID}`,
    'm:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA',
    'm:AAAAAAAAAAAAAAAAAAAAAA:short',
    'm:AAAAAAAAAAAAAAAAAAAAAB:AAAAAAAAAAAAAAAAAAAAAA',
  ])('rejects %j', (data) => {
    expect(decodeCallback(data)).toBeUndefined();
  });
});

describe('quick-add callback data', () => {
  const quickAdd: QuickAddCallback[] = [
    { type: 'quickAddSave', draftId: ID },
    { type: 'quickAddCancel', draftId: ID },
  ];

  it.each(quickAdd)('round-trips %j within the limit of 64 bytes', (action) => {
    const data = encodeQuickAddCallback(action);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(QUICK_ADD_CALLBACK.test(data)).toBe(true);
    expect(decodeQuickAddCallback(data)).toEqual(action);
  });

  it('encodes compactly, and apart from the occurrence buttons', () => {
    expect(encodeQuickAddCallback({ type: 'quickAddSave', draftId: ID })).toBe(`qs:${ID}`);
    expect(encodeQuickAddCallback({ type: 'quickAddCancel', draftId: ID })).toBe(`qc:${ID}`);
    expect(decodeCallback(`qs:${ID}`)).toBeUndefined();
    expect(QUICK_ADD_CALLBACK.test(encodeCallback({ type: 'complete', occurrenceId: ID }))).toBe(
      false,
    );
    expect(decodeQuickAddCallback(encodeCallback({ type: 'complete', occurrenceId: ID }))).toBe(
      undefined,
    );
  });

  it.each([
    '',
    'qs',
    'qs:',
    'qs:not-a-uuid',
    `qx:${ID}`,
    `q:${ID}`,
    `qs:extra:${ID}`,
    `qs:${ID}:extra`,
    `QS:${ID}`,
    `qs:${ID.toUpperCase()}`,
    ID,
  ])('rejects %j', (data) => {
    expect(decodeQuickAddCallback(data)).toBeUndefined();
  });
});
