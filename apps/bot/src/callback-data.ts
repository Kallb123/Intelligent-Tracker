import { SNOOZE_OPTION_KEYS, type SnoozeOptionKey } from '@tracker/core';

/*
 * What an inline button carries back to the bot when it is pressed. Telegram allows 64 bytes, so
 * the data is `<action>:<occurrence uuid>` (the longest, a snooze choice, is `n:tomorrow:<uuid>`
 * at 47 bytes). It is all the bot keeps about a button: who pressed it comes from the update, and
 * which message it was on from the callback query.
 *
 * The two buttons on a `/add` confirmation card are the exception: they carry a quick-add draft's
 * id (`qs:<uuid>` to save it, `qc:<uuid>` to cancel it, 39 bytes), and are told apart from the
 * occurrence buttons by `QUICK_ADD_CALLBACK`.
 */

/** A button press: what to do, to which occurrence. */
export type CallbackAction =
  | { type: 'complete' | 'start' | 'skip' | 'snoozeMenu' | 'back'; occurrenceId: string }
  | { type: 'snooze'; key: SnoozeOptionKey; occurrenceId: string };

const SIMPLE_CODES = {
  d: 'complete',
  s: 'start',
  x: 'skip',
  z: 'snoozeMenu',
  b: 'back',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type SimpleType = (typeof SIMPLE_CODES)[keyof typeof SIMPLE_CODES];
const CODE_OF = Object.fromEntries(
  Object.entries(SIMPLE_CODES).map(([code, type]) => [type, code]),
) as Record<SimpleType, string>;

export function encodeCallback(action: CallbackAction): string {
  return action.type === 'snooze'
    ? `n:${action.key}:${action.occurrenceId}`
    : `${CODE_OF[action.type]}:${action.occurrenceId}`;
}

/** The action a button's data stands for, or undefined for data this bot did not produce. */
export function decodeCallback(data: string): CallbackAction | undefined {
  const parts = data.split(':');
  const occurrenceId = parts[parts.length - 1];
  if (occurrenceId === undefined || !UUID.test(occurrenceId)) return undefined;

  if (parts.length === 2) {
    const type = SIMPLE_CODES[parts[0] as keyof typeof SIMPLE_CODES];
    return type ? { type, occurrenceId } : undefined;
  }
  if (parts.length === 3 && parts[0] === 'n') {
    const key = SNOOZE_OPTION_KEYS.find((candidate) => candidate === parts[1]);
    return key ? { type: 'snooze', key, occurrenceId } : undefined;
  }
  return undefined;
}

/** A press on a `/add` confirmation card: what to do, to which draft. */
export interface QuickAddCallback {
  type: 'quickAddSave' | 'quickAddCancel';
  draftId: string;
}

const QUICK_ADD_CODES = { qs: 'quickAddSave', qc: 'quickAddCancel' } as const;

/** Matches the data of the quick-add buttons (well formed or not), for routing a press to them. */
export const QUICK_ADD_CALLBACK = /^q[sc]:/;

export function encodeQuickAddCallback({ type, draftId }: QuickAddCallback): string {
  return `${type === 'quickAddSave' ? 'qs' : 'qc'}:${draftId}`;
}

/** The quick-add action a button's data stands for, or undefined for data this bot did not produce. */
export function decodeQuickAddCallback(data: string): QuickAddCallback | undefined {
  const [code, draftId, ...rest] = data.split(':');
  const type = QUICK_ADD_CODES[code as keyof typeof QUICK_ADD_CODES];
  return type && draftId !== undefined && rest.length === 0 && UUID.test(draftId)
    ? { type, draftId }
    : undefined;
}
