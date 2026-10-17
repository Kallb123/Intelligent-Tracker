import type { ReminderSlot } from '@tracker/shared';
import type { Span } from './spans.js';
import { COUNT, toCount, UNIT_DAYS } from './words.js';
import type { Unit } from './words.js';

/** The longest prep window the api accepts (`leadTimeDays`). */
const MAX_LEAD_DAYS = 3650;

const LEAD_VERB = String.raw`(?:sort\s+(?:it|this|that)(?:\s+out)?|start(?:\s+(?:on\s+)?(?:it|this|that))?|get\s+(?:started|going)|begin|prep(?:are)?|plan|remind\s+me|tell\s+me|heads[- ]?up)`;
const LEAD = new RegExp(
  String.raw`\b(?:${LEAD_VERB}\s+)?(${COUNT})\s+(day|week|fortnight|month)s?\s+(?:before|ahead(?:\s+of)?|early|earlier|in\s+advance(?:\s+of)?|beforehand)\b`,
  'iu',
);
const REMIND_OFFSET = new RegExp(
  String.raw`\b(?:(?:and\s+)?(?:remind|ping|nudge|tell)\s+me\s+)?(?:on\s+)?the\s+(night|evening|day|morning)\s+before\b`,
  'iu',
);

export interface LeadFound extends Span {
  leadTimeDays: number;
}

/**
 * "a month before" (30 days, as the templates use), "2 weeks ahead", "3 days early", with an
 * optional verb in front ("sort it", "start", "remind me"). A count is required, so "the day
 * before" is not a lead time (see `findReminderOffset`).
 */
export function findLeadTime(text: string): LeadFound | null {
  const match = LEAD.exec(text);
  if (!match) return null;
  const days = toCount(match[1] as string) * UNIT_DAYS[(match[2] as string).toLowerCase() as Unit];
  if (days > MAX_LEAD_DAYS) return null;
  return { start: match.index, end: match.index + match[0].length, leadTimeDays: days };
}

export interface ReminderOffsetFound extends Span {
  remindOffsetDays: number;
  reminderSlot: ReminderSlot;
}

/**
 * "the night before", "the day before", "remind me the evening before": remind on the day before
 * the due date (PLAN 4.4), in the evening slot ("the morning before" uses the morning slot).
 */
export function findReminderOffset(text: string): ReminderOffsetFound | null {
  const match = REMIND_OFFSET.exec(text);
  if (!match) return null;
  return {
    start: match.index,
    end: match.index + match[0].length,
    remindOffsetDays: -1,
    reminderSlot: (match[1] as string).toLowerCase() === 'morning' ? 'morning' : 'evening',
  };
}
