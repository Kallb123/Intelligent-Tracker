import { snoozeUntil } from '@tracker/core';
import {
  applyOccurrenceAction,
  findHouseholdByTelegramChat,
  findMemberByTelegramUserId,
  OccurrenceActionError,
  telegramMessageNotifications,
  type Database,
  type OccurrenceAction,
  type OccurrenceActionInput,
} from '@tracker/db';
import { GrammyError, type Bot } from 'grammy';
import { decodeCallback, type CallbackAction } from './callback-data.js';
import type { BotDeps } from './deps.js';
import { errorFields } from './logger.js';
import { buildGroupMessage, messageOptions } from './message.js';
import { formatSnoozeUntil } from './render.js';

/*
 * Button presses on a reminder message in the house group. A press is only honoured in the
 * household's linked group, from a Telegram user linked to one of its members, and is attributed
 * to that member. Afterwards the original message is edited in place, redrawn from the database,
 * so it always shows where each occurrence really stands (also when someone else just changed
 * it, or it was changed in the web app).
 */

const LINK_FIRST =
  'Connect your Telegram first: in the web app, go to Account → Connect Telegram. ' +
  'Then press the button again.';

/** What a press does to the occurrence, and what to tell the presser (the toast). */
interface Outcome {
  toast?: string;
  /** Redraw the message with this occurrence's snooze choices open. */
  snoozeFor?: string;
}

/** Telegram refuses an edit that changes nothing, which happens when a press had no effect. */
function isNotModified(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    error.description.includes('message is not modified')
  );
}

export function registerActions(bot: Bot, deps: BotDeps): void {
  const { db, now, logger } = deps;

  // Presses cannot race each other: `bot.start()` long polling (grammY's built-in runner)
  // handles updates one at a time, and Telegram allows a single `getUpdates` consumer per token,
  // so the render and edit after one press's action are never interleaved with another press's.
  bot.on('callback_query:data', async (ctx) => {
    const action = decodeCallback(ctx.callbackQuery.data);
    const message = ctx.callbackQuery.message;
    if (!action || !message) {
      await ctx.answerCallbackQuery({ text: 'That button is out of date.' });
      return;
    }

    try {
      // Buttons in any other chat are none of our business.
      const household = await findHouseholdByTelegramChat(db, message.chat.id);
      if (!household) {
        await ctx.answerCallbackQuery();
        return;
      }
      const presser = await findMemberByTelegramUserId(db, ctx.from.id);
      if (!presser || presser.householdId !== household.id) {
        await ctx.answerCallbackQuery({ text: LINK_FIRST, show_alert: true });
        return;
      }
      const notifications = await telegramMessageNotifications(
        db,
        household.id,
        message.chat.id,
        message.message_id,
      );
      if (notifications.length === 0) {
        await ctx.answerCallbackQuery({ text: 'I no longer have the details of that message.' });
        return;
      }

      const at = now();
      const outcome = await resolveOutcome(
        action,
        (change) =>
          applyAs(db, {
            householdId: household.id,
            memberId: presser.id,
            occurrenceId: action.occurrenceId,
            now: at,
            action: change,
          }),
        { now: at, timezone: household.timezone, eveningSlot: household.eveningSlot },
      );

      const rendered = await buildGroupMessage(db, household, notifications, {
        now: at,
        ...(outcome.snoozeFor ? { snoozeFor: outcome.snoozeFor } : {}),
      });
      try {
        await ctx.api.editMessageText(
          message.chat.id,
          message.message_id,
          rendered.text,
          messageOptions(rendered),
        );
      } catch (error) {
        if (!isNotModified(error)) {
          logger.error('editing the message failed', {
            chatId: message.chat.id,
            messageId: message.message_id,
            ...errorFields(error),
          });
        }
      }
      await ctx.answerCallbackQuery(outcome.toast ? { text: outcome.toast } : undefined);
    } catch (error) {
      logger.error('button press failed', { data: ctx.callbackQuery.data, ...errorFields(error) });
      await ctx.answerCallbackQuery({ text: 'Something went wrong. Try again.' }).catch(() => {});
    }
  });
}

/**
 * Applies the change as the member. Returns why nothing was done (the toast to show), or
 * undefined when it was done.
 */
async function applyAs(db: Database, input: OccurrenceActionInput): Promise<string | undefined> {
  try {
    const result = await applyOccurrenceAction(db, input);
    return result.changed ? undefined : 'Already started';
  } catch (error) {
    if (!(error instanceof OccurrenceActionError)) throw error;
    return error.code === 'not_found'
      ? 'That job no longer exists.'
      : `That job is already ${error.status ?? 'closed'}.`;
  }
}

/** Carries out a press with `apply` and words the toast: the refusal, or else what was done. */
async function resolveOutcome(
  action: CallbackAction,
  apply: (change: OccurrenceAction) => Promise<string | undefined>,
  snooze: { now: Date; timezone: string; eveningSlot: string },
): Promise<Outcome> {
  switch (action.type) {
    case 'snoozeMenu':
      return { snoozeFor: action.occurrenceId };
    case 'back':
      return {};
    case 'complete':
      return { toast: (await apply({ type: 'complete' })) ?? '✅ Done' };
    case 'skip':
      return { toast: (await apply({ type: 'skip' })) ?? '⏭ Skipped' };
    case 'start':
      return { toast: (await apply({ type: 'start' })) ?? '▶️ Started' };
    case 'snooze': {
      const until = snoozeUntil(action.key, snooze);
      if (!until) return { toast: 'That time has already passed.' };
      return {
        toast:
          (await apply({ type: 'snooze', until })) ??
          `⏰ Snoozed until ${formatSnoozeUntil(until, snooze.timezone)}`,
      };
    }
  }
}
