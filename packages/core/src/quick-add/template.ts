import type { Template } from '@tracker/shared';
import { suggestTemplates } from '../templates.js';
import type { LocalDate } from '../recurrence/types.js';
import { anchorTemplateRule } from './schedule.js';
import type { RecurrencePattern } from './recurrence-phrase.js';
import type { Span } from './spans.js';
import type { QuickAddTask } from './types.js';

/** The best template for the text that is left once dates, repeats and names are taken out. */
export function matchTemplate(remaining: string, templates: readonly Template[]): Template | null {
  return suggestTemplates(remaining, templates)[0] ?? null;
}

/**
 * Where the matched template's keyword is in the original text, for the "what was understood"
 * list. The longest keyword that appears wins, mirroring how `suggestTemplates` scores.
 */
export function templateKeywordSpan(text: string, template: Template): Span | null {
  const keywords = [...template.keywords].sort((a, b) => b.length - a.length);
  for (const keyword of keywords) {
    const parts = keyword.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (parts.length === 0) continue;
    const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`));
    const pattern = new RegExp(
      String.raw`(?<![\p{L}\p{N}])${escaped.join(String.raw`[^\p{L}\p{N}]+`)}(?![\p{L}\p{N}])`,
      'iu',
    );
    const match = pattern.exec(text);
    if (match) return { start: match.index, end: match.index + match[0].length };
  }
  return null;
}

/**
 * The repeat a template implies, for when the text gave none: its rule (made specific to
 * `dueDate`, see `anchorTemplateRule`) or its after-completion interval. A one-off template gives
 * nothing.
 */
export function templatePattern(
  template: Template,
  dueDate: LocalDate,
): RecurrencePattern | undefined {
  const d = template.defaults;
  if (d.scheduleKind === 'fixed' && d.rrule) {
    return { kind: 'rrule', rrule: anchorTemplateRule(d.rrule, dueDate) };
  }
  if (d.scheduleKind === 'after_completion' && d.intervalAfterCompletionDays) {
    return { kind: 'after_completion', days: d.intervalAfterCompletionDays };
  }
  return undefined;
}

export type TemplateGaps = Pick<
  QuickAddTask,
  | 'leadTimeDays'
  | 'milestones'
  | 'reminderProfile'
  | 'category'
  | 'notes'
  | 'workingDaysOnly'
  | 'remindOffsetDays'
  | 'reminderSlot'
  | 'reminderCustomTime'
>;

/**
 * The template's reminder settings and extras. The caller lays the user's own phrases over the
 * top, so the template only ever fills what the text did not say. Empty values are left out.
 */
export function templateFields(template: Template): Partial<TemplateGaps> {
  const d = template.defaults;
  const fields: Partial<TemplateGaps> = {};
  if (d.leadTimeDays !== undefined && d.leadTimeDays !== null) fields.leadTimeDays = d.leadTimeDays;
  if (d.milestones?.length) fields.milestones = d.milestones.map((m) => ({ ...m }));
  if (d.reminderProfile) fields.reminderProfile = d.reminderProfile;
  if (d.category) fields.category = d.category;
  if (d.notes) fields.notes = d.notes;
  if (d.workingDaysOnly) fields.workingDaysOnly = true;
  if (d.remindOffsetDays !== undefined) fields.remindOffsetDays = d.remindOffsetDays;
  if (d.reminderSlot) fields.reminderSlot = d.reminderSlot;
  if (d.reminderCustomTime) fields.reminderCustomTime = d.reminderCustomTime;
  return fields;
}
