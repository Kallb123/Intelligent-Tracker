import type { SnoozeOption, SnoozeOptionKey } from '@tracker/core';
import type { OccurrenceState } from '@tracker/db';
import { describeReminder, instantToWall, OPEN_OCCURRENCE_STATUSES } from '@tracker/shared';
import type { ReminderPayload } from '@tracker/shared';
import { encodeCallback } from './callback-data.js';

/*
 * What a reminder message in the house group looks like, as pure functions of the data: the
 * reminders it carries, the state each occurrence is in now, and (while someone is choosing a
 * snooze) which occurrence's row is open. Nothing here reads the database or talks to Telegram,
 * so it is tested with plain objects; `message.ts` gathers the data and the handlers send the
 * result. The same function renders the message when it is first sent and again after every
 * button press, which is what keeps the message in step with the occurrences it shows.
 *
 * The text is Telegram HTML, so everything that comes from a person (task titles, names) goes
 * through `escapeHtml`.
 */

/** One reminder line of a message. */
export interface RenderLine {
  payload: ReminderPayload;
  /** Who the reminder is for; null says "Anyone". `telegramUserId` null means not linked yet. */
  assignee: { name: string; telegramUserId: number | null } | null;
}

export interface SnoozeChoice {
  key: SnoozeOptionKey;
  label: string;
}

export interface RenderInput {
  /** In message order. */
  lines: RenderLine[];
  /** The state of each occurrence by id; an occurrence that is missing no longer exists. */
  states: ReadonlyMap<string, OccurrenceState>;
  /** The household's zone, for the times in the text. */
  timeZone: string;
  now: Date;
  /** When set, that occurrence's row offers these snooze choices (and a way back) instead. */
  snoozeMenu?: { occurrenceId: string; choices: SnoozeChoice[] };
}

/** An inline keyboard button; structurally what the Bot API takes. */
export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface RenderedMessage {
  /** Telegram HTML. */
  text: string;
  keyboard: InlineButton[][];
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** Escapes text for Telegram's HTML parse mode, which only needs these three. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => HTML_ESCAPES[char] as string);
}

const SNOOZE_LABELS: Record<SnoozeOptionKey, string> = {
  tonight: 'Tonight',
  tomorrow: 'Tomorrow',
  weekend: 'Weekend',
  '3d': '3 days',
};

/**
 * The snooze options as buttons. "Weekend" is dropped when it is the same instant as
 * "Tomorrow" (on a Friday), where offering both would be two buttons for one choice.
 */
export function snoozeChoices(options: SnoozeOption[]): SnoozeChoice[] {
  const tomorrow = options.find((option) => option.key === 'tomorrow');
  return options
    .filter(
      (option) =>
        !(
          option.key === 'weekend' &&
          tomorrow &&
          tomorrow.until.getTime() === option.until.getTime()
        ),
    )
    .map(({ key }) => ({ key, label: SNOOZE_LABELS[key] }));
}

/** A snooze deadline for people to read: "Tue 19:00", in the household's zone. */
export function formatSnoozeUntil(until: Date, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(until);
  return `${weekday} ${instantToWall(until, timeZone).time}`;
}

const isOpen = (state: OccurrenceState | undefined): state is OccurrenceState =>
  state !== undefined && (OPEN_OCCURRENCE_STATUSES as readonly string[]).includes(state.status);

/** " by Sam", or nothing when it is not known who did it. */
function by(name: string | null | undefined): string {
  return name ? ` by ${escapeHtml(name)}` : '';
}

/** What a line says about its occurrence, if anything (closed lines are also struck through). */
function noteFor(
  state: OccurrenceState | undefined,
  now: Date,
  timeZone: string,
): string | undefined {
  if (!state) return '🗑 Removed';
  switch (state.status) {
    case 'done':
      return `✅ Done${by(state.actors.completed)}`;
    case 'skipped':
      return `⏭ Skipped${by(state.actors.skipped)}`;
    default:
      if (state.snoozedUntil && state.snoozedUntil > now) {
        return `⏰ Snoozed until ${formatSnoozeUntil(state.snoozedUntil, timeZone)}${by(state.actors.snoozed)}`;
      }
      return state.status === 'started' ? `▶️ Started${by(state.actors.started)}` : undefined;
  }
}

function renderLine(
  line: RenderLine,
  number: number | undefined,
  state: OccurrenceState | undefined,
  { now, timeZone }: Pick<RenderInput, 'now' | 'timeZone'>,
): string {
  const open = isOpen(state);
  const { assignee } = line;
  // A mention pings the person, which is only wanted while there is something left to do; a
  // closed line (struck through) just names them.
  const who = !assignee
    ? 'Anyone 🙋'
    : open && assignee.telegramUserId !== null
      ? `<a href="tg://user?id=${assignee.telegramUserId}">${escapeHtml(assignee.name)}</a>`
      : escapeHtml(assignee.name);
  const text = `${who}: ${escapeHtml(describeReminder(line.payload, timeZone))}`;
  const note = noteFor(state, now, timeZone);
  return `${number === undefined ? '' : `${number}. `}${open ? text : `<s>${text}</s>`}${note ? `\n${note}` : ''}`;
}

/** The buttons of one open occurrence; `n` is its (first) line number when there are several. */
function actionRow(
  occurrenceId: string,
  state: OccurrenceState,
  n: number | undefined,
): InlineButton[] {
  const label = (icon: string, word: string): string => `${icon} ${n ?? word}`;
  const button = (
    text: string,
    type: 'complete' | 'start' | 'snoozeMenu' | 'skip',
  ): InlineButton => ({
    text,
    callback_data: encodeCallback({ type, occurrenceId }),
  });
  return [
    button(label('✅', 'Done'), 'complete'),
    // Starting a started occurrence does nothing, so the button goes once it is.
    ...(state.status === 'started' ? [] : [button(label('▶️', 'Started'), 'start')]),
    button(label('⏰', 'Snooze'), 'snoozeMenu'),
    button(label('⏭', 'Skip'), 'skip'),
  ];
}

/**
 * Builds the message: one numbered line per reminder (numbers only when there is more than one),
 * struck through with who closed it once its occurrence is done or skipped, and one row of
 * buttons per distinct occurrence that is still open (several reminders of one occurrence share
 * its row). With several occurrences the buttons say which line they are for ("✅ 2"), since the
 * row's position is all that ties it to its line.
 */
export function renderMessage(input: RenderInput): RenderedMessage {
  const { lines, states, snoozeMenu } = input;
  const numbered = lines.length > 1;
  const text = lines
    .map((line, i) =>
      renderLine(line, numbered ? i + 1 : undefined, states.get(line.payload.occurrenceId), input),
    )
    .join('\n\n');

  // First line of each occurrence, in message order.
  const firstLine = new Map<string, number>();
  lines.forEach((line, i) => {
    if (!firstLine.has(line.payload.occurrenceId)) firstLine.set(line.payload.occurrenceId, i + 1);
  });
  const several = firstLine.size > 1;

  const keyboard: InlineButton[][] = [];
  for (const [occurrenceId, n] of firstLine) {
    const state = states.get(occurrenceId);
    if (!isOpen(state)) continue;
    if (snoozeMenu?.occurrenceId === occurrenceId) {
      keyboard.push(
        snoozeMenu.choices.map(({ key, label }) => ({
          text: label,
          callback_data: encodeCallback({ type: 'snooze', key, occurrenceId }),
        })),
        [{ text: '↩ Back', callback_data: encodeCallback({ type: 'back', occurrenceId }) }],
      );
    } else {
      keyboard.push(actionRow(occurrenceId, state, several ? n : undefined));
    }
  }
  return { text, keyboard };
}
