import { findAssignee } from './assignee.js';
import { findDateTime } from './date.js';
import { findLeadTime, findReminderOffset } from './lead.js';
import { findRecurrence } from './recurrence-phrase.js';
import { buildSchedule } from './schedule.js';
import { blank, cleanTitle, type Span } from './spans.js';
import { matchTemplate, templateFields, templateKeywordSpan, templatePattern } from './template.js';
import type {
  QuickAddContext,
  QuickAddMatch,
  QuickAddMatchKind,
  QuickAddParse,
  QuickAddTask,
} from './types.js';

/** The longest title the api accepts. */
const MAX_TITLE = 200;

/**
 * Turns one line of typed text into a task, in the stages of PLAN 4.8: recurrence phrase, lead
 * time and remind offset, assignee, date and time (`chrono.en.GB`, day-first), then a template
 * for whatever is still unset. Each stage reads the text with earlier stages' words blanked out.
 *
 * Whatever is not understood stays in the title; nothing is guessed. Explicit phrases always win
 * over the template. The result is a proposal for a confirmation card, not a saved task.
 * Throws `RecurrenceError` only for an unknown `timezone` or an invalid `now`.
 */
export function parseQuickAdd(text: string, ctx: QuickAddContext): QuickAddParse {
  const matched: QuickAddMatch[] = [];
  let remaining = text;
  const take = (kind: QuickAddMatchKind, span: Span): void => {
    matched.push({ kind, text: text.slice(span.start, span.end), ...span });
    remaining = blank(remaining, [span]);
  };

  const recurrence = findRecurrence(remaining);
  if (recurrence) take('recurrence', recurrence);

  const lead = findLeadTime(remaining);
  if (lead) take('lead', lead);
  const offset = findReminderOffset(remaining);
  if (offset) take('lead', offset);

  const assignee = findAssignee(remaining, ctx.members);
  if (assignee) take('assignee', assignee);

  const when = findDateTime(remaining, ctx.now, ctx.timezone);
  for (const piece of when.pieces) take(piece.kind, piece);

  const template = matchTemplate(remaining, ctx.templates);
  const keyword = template ? templateKeywordSpan(text, template) : null;
  if (template && keyword) {
    matched.push({ kind: 'template', text: text.slice(keyword.start, keyword.end), ...keyword });
  }
  matched.sort((a, b) => a.start - b.start);

  // A template's repeat only fills in when the text named a date for it to hang on.
  const pattern =
    recurrence?.pattern ??
    (template && when.date !== undefined ? templatePattern(template, when.date) : undefined);
  const schedule = buildSchedule({ ...when, pattern }, ctx.now, ctx.timezone);

  const title =
    cleanTitle(
      remaining,
      matched.some((m) => m.kind !== 'template'),
    ) ||
    template?.title ||
    text.trim();

  const fromTemplate = template ? templateFields(template) : {};
  if (offset) {
    // The user's own slot and offset replace the template's.
    delete fromTemplate.reminderSlot;
    delete fromTemplate.reminderCustomTime;
  }

  const task: QuickAddTask = {
    title: title.slice(0, MAX_TITLE).trim(),
    ...schedule,
    assigneeIds: assignee ? [assignee.member.id] : [],
    workingDaysOnly: false,
    remindOffsetDays: 0,
    reminderSlot: 'evening',
    milestones: [],
    ...fromTemplate,
    ...(lead ? { leadTimeDays: lead.leadTimeDays } : {}),
    ...(offset
      ? { remindOffsetDays: offset.remindOffsetDays, reminderSlot: offset.reminderSlot }
      : {}),
  };
  return { task, template, matched };
}
