import type { QuickAddMatch, QuickAddMatchKind, QuickAddParse, QuickAddTask } from '@tracker/core';
import { taskBodySchema } from '@tracker/shared';
import type { TaskInput } from '../api/types.js';
import { formFromTask, type TaskForm } from './task-form.js';

/**
 * Turning a quick-add parse into what the web sends or edits. Kept apart from the component so it
 * is unit-tested without a DOM.
 */

/** The parsed task, assigned to the person adding it when the text named nobody. */
export function quickAddTask(parse: QuickAddParse, memberId: string | undefined): QuickAddTask {
  const { assigneeIds } = parse.task;
  if (assigneeIds.length > 0 || !memberId) return parse.task;
  return { ...parse.task, assigneeIds: [memberId] };
}

/** The body for `POST /api/tasks`: the parsed task, assigned as `quickAddTask` says. */
export function quickAddBody(parse: QuickAddParse, memberId: string | undefined): TaskInput {
  // The parser leaves unset optional fields out rather than setting them to undefined, which its
  // type cannot say; the api's request type is stricter about that. The parse always passes
  // `taskBodySchema`.
  return quickAddTask(parse, memberId) as TaskInput;
}

/** The task editor's form for the parsed task, so "Edit details" starts from what was understood. */
export function quickAddForm(
  parse: QuickAddParse,
  memberId: string | undefined,
  timeZone: string,
): TaskForm {
  return formFromTask(taskBodySchema.parse(quickAddTask(parse, memberId)), timeZone);
}

/** A stretch of the typed text; `kind` is set when the parser understood it. */
export interface TextSegment {
  text: string;
  kind: QuickAddMatchKind | null;
}

/** The typed text cut into plain and understood pieces, in order, for highlighting. */
export function highlightMatches(text: string, matched: readonly QuickAddMatch[]): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const m of [...matched].sort((a, b) => a.start - b.start)) {
    if (m.start < cursor || m.end <= m.start) continue;
    if (m.start > cursor) segments.push({ text: text.slice(cursor, m.start), kind: null });
    segments.push({ text: text.slice(m.start, m.end), kind: m.kind });
    cursor = m.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), kind: null });
  return segments;
}
