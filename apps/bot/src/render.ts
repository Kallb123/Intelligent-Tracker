import type { SnoozeOption, SnoozeOptionKey } from '@tracker/core';
import { DEFAULT_OUTBOX_MESSAGE_SIZE, type OccurrenceState } from '@tracker/db';
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
 *
 * Telegram rejects a message longer than 4096 characters, counted on the text after the HTML is
 * parsed, and the edit after a button press is the same message again, so nothing here may
 * exceed it in any state. A line can be long (a 200-character title, a 200-character milestone
 * title, two names and a "Done by" note), and the outbox puts up to `DEFAULT_OUTBOX_MESSAGE_SIZE`
 * lines in one message, so each line gets a fixed budget of visible characters
 * (`MAX_LINE_LENGTH`) and its task text is cut with an ellipsis to fit what its name and note
 * leave over. The cut is made on the plain text before it is escaped, so an entity is never
 * split.
 */

/** The most characters Telegram accepts in a message, after entity parsing. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

const LINE_SEPARATOR = '\n\n';

/**
 * The most visible characters one line may have (its number, text and note), so that a full
 * batch of `DEFAULT_OUTBOX_MESSAGE_SIZE` lines and the separators between them fit in a message.
 */
export const MAX_LINE_LENGTH = Math.floor(
  (TELEGRAM_MESSAGE_LIMIT - LINE_SEPARATOR.length * (DEFAULT_OUTBOX_MESSAGE_SIZE - 1)) /
    DEFAULT_OUTBOX_MESSAGE_SIZE,
);

/** A member's name is cut to this in a line, whatever its length in the database. */
const MAX_NAME_LENGTH = 40;

/**
 * `text` cut to at most `max` characters, ending in "…" when it was cut. Lengths are UTF-16
 * code units, the stricter way to count, and a surrogate pair is never split.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

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
  return name ? ` by ${truncate(name, MAX_NAME_LENGTH)}` : '';
}

/**
 * What a line says about its occurrence, if anything (closed lines are also struck through), as
 * plain text: the caller escapes it once it knows how much room the line has.
 */
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
  const prefix = number === undefined ? '' : `${number}. `;
  const note = noteFor(state, now, timeZone);
  const name = assignee ? truncate(assignee.name, MAX_NAME_LENGTH) : 'Anyone 🙋';
  // What is left of the line's budget once the number, the name (and its ": ") and the note
  // (and the line break before it) are counted, for the reminder's own text.
  const room = MAX_LINE_LENGTH - prefix.length - name.length - 2 - (note ? note.length + 1 : 0);
  // A mention pings the person, which is only wanted while there is something left to do; a
  // closed line (struck through) just names them.
  const who =
    assignee && open && assignee.telegramUserId !== null
      ? `<a href="tg://user?id=${assignee.telegramUserId}">${escapeHtml(name)}</a>`
      : escapeHtml(name);
  const text = `${who}: ${escapeHtml(truncate(describeReminder(line.payload, timeZone), room))}`;
  return `${prefix}${open ? text : `<s>${text}</s>`}${note ? `\n${escapeHtml(note)}` : ''}`;
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
 * Builds the message: one numbered line per reminder (numbers only when there is more than one;
 * at most `DEFAULT_OUTBOX_MESSAGE_SIZE` of them, which the outbox guarantees),
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
    .join(LINE_SEPARATOR);

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
