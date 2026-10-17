import type { QuickAddRow } from '@tracker/core';
import { MAX_TITLE_LENGTH } from '@tracker/shared';
import type { InlineKeyboardButton } from 'grammy/types';
import { encodeQuickAddCallback } from './callback-data.js';
import { plain } from './digest.js';
import { MAX_NAME_LENGTH, truncate } from './render.js';

/*
 * What the `/add` confirmation card and its outcomes look like, as pure functions of the data:
 * the parsed task's title and rows (`describeQuickAdd`, the same rows the web preview shows), and
 * the buttons. Plain text, sent without a parse mode, so what someone typed cannot inject markup;
 * every piece of it goes through `plain`, which also defuses "@"s so a title or a name cannot ping
 * anyone. Each piece is cut to a fixed length, which keeps the card well inside Telegram's limit
 * (4096 characters): a title and at most eight rows.
 */

/** A row's value (a long milestone list, say) is cut to this. */
const MAX_ROW_LENGTH = 400;

/**
 * The longest "Edit in app" address Telegram is sent. Its limit is not documented; this is well
 * under the 2,048 characters that links are commonly held to.
 */
const MAX_EDIT_URL_LENGTH = 1500;

/** The card shown for a draft, until Save or Cancel is pressed. */
export function renderQuickAddCard(title: string, rows: readonly QuickAddRow[]): string {
  const lines = rows.map(({ label, value }) => `${label}: ${plain(value, MAX_ROW_LENGTH)}`);
  return ['Add this job?', '', plain(title, MAX_TITLE_LENGTH), ...lines].join('\n');
}

/** The card after Save: who the job is for, and where to find it in the app (when that is known). */
export function renderQuickAddSaved(
  task: { id: string; title: string },
  names: readonly string[],
  publicBaseUrl: string | undefined,
): string {
  const who = names.map((name) => plain(name, MAX_NAME_LENGTH)).join(', ');
  return (
    `✅ Added "${plain(task.title, MAX_TITLE_LENGTH)}" for ${who}.` +
    (publicBaseUrl ? `\n${publicBaseUrl}/tasks/${task.id}` : '')
  );
}

/** The card after Cancel. */
export function renderQuickAddCancelled(title: string): string {
  return `✖️ Cancelled "${plain(title, MAX_TITLE_LENGTH)}". Nothing was added.`;
}

/** The card after Save when the draft turned out not to be saveable. */
export function renderQuickAddFailed(title: string): string {
  return `⚠️ I could not add "${plain(title, MAX_TITLE_LENGTH)}". Send /add to try again.`;
}

/**
 * Where "Edit in app" goes: the app's home page, which opens its quick-add preview with the text
 * filled in. A text too long for the address is cut (with "…"), so the button always works.
 */
export function editInAppUrl(publicBaseUrl: string, text: string): string {
  const urlFor = (t: string): string => `${publicBaseUrl}/?quickAdd=${encodeURIComponent(t)}`;
  let shown = text;
  while (urlFor(shown).length > MAX_EDIT_URL_LENGTH && shown.length > 1) {
    shown = truncate(shown, Math.floor(shown.length * 0.8));
  }
  return urlFor(shown);
}

/**
 * The card's buttons, in one row: Save, Edit in app (only when the app's address is known), and
 * Cancel. Save and Cancel carry the draft's id; Edit in app is a link, with no data.
 */
export function quickAddKeyboard(
  draftId: string,
  edit: { publicBaseUrl: string; text: string } | undefined,
): InlineKeyboardButton[][] {
  return [
    [
      { text: '✅ Save', callback_data: encodeQuickAddCallback({ type: 'quickAddSave', draftId }) },
      ...(edit
        ? [{ text: '✏️ Edit in app', url: editInAppUrl(edit.publicBaseUrl, edit.text) }]
        : []),
      {
        text: '✖️ Cancel',
        callback_data: encodeQuickAddCallback({ type: 'quickAddCancel', draftId }),
      },
    ],
  ];
}
