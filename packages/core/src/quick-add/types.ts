import type { Template, TaskBody } from '@tracker/shared';

/** A household member the quick-add can assign to. */
export interface QuickAddMember {
  id: string;
  name: string;
}

export interface QuickAddContext {
  /** The moment of typing: "today", "tomorrow" and "next Tuesday" are read from it, in `timezone`. */
  now: Date;
  /** The household's IANA zone, e.g. `Europe/London`. */
  timezone: string;
  members: readonly QuickAddMember[];
  /** `UK_TEMPLATES` plus the household's own. */
  templates: readonly Template[];
}

/**
 * The fields to send to `POST /api/tasks`. It always passes `taskBodySchema` (given a non-blank
 * title). Optional fields are left out, never `null`, when nothing set them; `assigneeIds` is
 * empty when nobody was named (callers default it to the author) and `reminderProfile` is only
 * present when a template sets it (the api applies the household default).
 */
export type QuickAddTask = Pick<
  TaskBody,
  | 'title'
  | 'scheduleKind'
  | 'allDay'
  | 'assigneeIds'
  | 'workingDaysOnly'
  | 'remindOffsetDays'
  | 'reminderSlot'
  | 'milestones'
> &
  Partial<
    Pick<
      TaskBody,
      | 'dueDate'
      | 'dueAt'
      | 'rrule'
      | 'intervalAfterCompletionDays'
      | 'leadTimeDays'
      | 'reminderCustomTime'
      | 'reminderProfile'
      | 'category'
      | 'notes'
    >
  >;

export type QuickAddMatchKind = 'date' | 'time' | 'recurrence' | 'lead' | 'assignee' | 'template';

/** A piece of the input the parser understood. `start`/`end` are offsets into the original text. */
export interface QuickAddMatch {
  kind: QuickAddMatchKind;
  /** The text as typed, e.g. `every other Tuesday`. */
  text: string;
  start: number;
  end: number;
}

export interface QuickAddParse {
  task: QuickAddTask;
  /** The template whose keywords matched, if any. It only filled what the text did not say. */
  template: Template | null;
  /**
   * What was understood, in input order. A phrase holding a date and a time ("tomorrow 7pm") is
   * one `date` piece; `time` is only for a time given on its own. `lead` covers both lead-time
   * ("a month before") and remind-offset ("the night before") phrases. A `template` piece is
   * the matched keyword; unlike the others it stays in the title.
   */
  matched: QuickAddMatch[];
}
