import {
  describeQuickAdd,
  parseQuickAdd,
  RecurrenceError,
  withDefaultAssignee,
} from '@tracker/core';
import {
  createQuickAddDraft,
  createTask,
  findHouseholdByTelegramChat,
  findMembersByIds,
  findQuickAddDraft,
  listMembers,
  listTemplates,
  normaliseBody,
  takeQuickAddDraft,
  taskColumns,
  type Household,
  type Member,
  type QuickAddDraft,
  type Task,
} from '@tracker/db';
import { taskBodySchema } from '@tracker/shared';
import { GrammyError, type Bot, type Context } from 'grammy';
import { decodeQuickAddCallback, QUICK_ADD_CALLBACK } from './callback-data.js';
import type { BotDeps } from './deps.js';
import { errorFields } from './logger.js';
import {
  quickAddKeyboard,
  renderQuickAddCancelled,
  renderQuickAddCard,
  renderQuickAddFailed,
  renderQuickAddSaved,
} from './quick-add-card.js';
import { linkFirst, memberInHousehold, NO_PREVIEW } from './sender.js';

/*
 * The quick-add flow behind `/add <text>`. The text goes through core's rule-based parser
 * (`parseQuickAdd`), and the group gets a confirmation card with what was understood and
 * Save / Cancel buttons (and Edit in app, when the app's address is known). Nothing is saved
 * until Save is pressed.
 *
 * The parsed task waits in a `quick_add_draft` row, because the buttons can only carry its id.
 * The draft is single-use (`takeQuickAddDraft` hands it to one press only, so a double tap
 * cannot save twice) and good for a day. Like the reminder buttons, a press is only honoured in
 * the household's linked group from a linked member; on top of that only the member who sent
 * `/add` may save or cancel their draft. Once it is saved or cancelled the card is edited in
 * place and loses its buttons.
 */

/** What the card of a draft that was saved or cancelled is replaced with: text and no buttons. */
const NO_BUTTONS = { ...NO_PREVIEW, reply_markup: { inline_keyboard: [] as never[] } };

/**
 * Parses `text` as `author` and replies in the chat with the confirmation card. The task is
 * kept as a draft, for the author to save.
 */
export async function sendQuickAddCard(
  ctx: Context,
  deps: BotDeps,
  household: Household,
  author: Member,
  text: string,
): Promise<void> {
  const { db, now, publicBaseUrl, logger } = deps;
  const at = now();
  const members = await listMembers(db, household.id);
  const parse = parseQuickAdd(text, {
    now: at,
    timezone: household.timezone,
    members: members.map(({ id, name }) => ({ id, name })),
    templates: await listTemplates(db, household.id),
  });
  const task = withDefaultAssignee(parse.task, author.id);
  const rows = describeQuickAdd(
    { ...parse, task },
    { members, timezone: household.timezone, now: at },
  );
  const draft = await createQuickAddDraft(db, {
    householdId: household.id,
    memberId: author.id,
    task,
    now: at,
  });
  const card = renderQuickAddCard(task.title, rows);

  try {
    const send = (edit: { publicBaseUrl: string; text: string } | undefined) =>
      ctx.reply(card, {
        ...NO_PREVIEW,
        reply_markup: { inline_keyboard: quickAddKeyboard(draft.id, edit) },
      });
    try {
      await send(publicBaseUrl ? { publicBaseUrl, text } : undefined);
    } catch (error) {
      // Telegram refuses a link button whose address it does not accept (a local one, say). The
      // card is still worth sending without it.
      if (!publicBaseUrl || !(error instanceof GrammyError) || error.error_code !== 400)
        throw error;
      logger.warn('quick-add card refused with its link, sending without', errorFields(error));
      await send(undefined);
    }
  } catch (error) {
    // No card, so nobody can press its buttons.
    await takeQuickAddDraft(db, { id: draft.id, householdId: household.id, now: at });
    throw error;
  }
}

/** What saving a draft came to. */
type SaveResult =
  { saved: Task; names: string[] } | { saved?: undefined; reason: 'gone' | 'invalid' };

/**
 * Saves the draft as a task, in one transaction with taking it, so a failure leaves the draft
 * for another try. A draft that is no longer valid (its schedule is rejected, say) is dropped
 * instead, as pressing Save again could not help.
 */
async function saveDraft(
  deps: BotDeps,
  household: Household,
  draft: QuickAddDraft,
  author: Member,
): Promise<SaveResult> {
  const { db, now } = deps;
  const at = now();
  try {
    return await db.transaction(async (tx): Promise<SaveResult> => {
      if (!(await takeQuickAddDraft(tx, { id: draft.id, householdId: household.id, now: at }))) {
        return { reason: 'gone' };
      }
      const body = taskBodySchema.safeParse(draft.task);
      if (!body.success) return { reason: 'invalid' };
      // Members named in the text may have been removed since; fall back to the author.
      const assignees = await findMembersByIds(tx, household.id, body.data.assigneeIds);
      const assigned = assignees.length > 0 ? assignees : [author];
      const fields = normaliseBody(
        { ...body.data, assigneeIds: assigned.map((m) => m.id) },
        household.defaultReminderProfile,
      );
      const saved = await createTask(tx, {
        householdId: household.id,
        createdBy: author.id,
        values: taskColumns(fields),
        assigneeIds: fields.assigneeIds,
        milestones: fields.milestones,
        now: at,
      });
      return { saved, names: assigned.map((m) => m.name) };
    });
  } catch (error) {
    if (!(error instanceof RecurrenceError)) throw error;
    await takeQuickAddDraft(db, { id: draft.id, householdId: household.id, now: at });
    return { reason: 'invalid' };
  }
}

export function registerQuickAdd(bot: Bot, deps: BotDeps): void {
  const { db, now, logger, publicBaseUrl } = deps;

  // Registered before the reminder buttons' handler, which answers any data it does not know as
  // out of date. As there, presses are handled one at a time (see `registerActions`).
  bot.callbackQuery(QUICK_ADD_CALLBACK, async (ctx) => {
    const action = decodeQuickAddCallback(ctx.callbackQuery.data);
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
      const presser = await memberInHousehold(db, household, ctx.from.id);
      if (!presser) {
        await ctx.answerCallbackQuery({
          text: linkFirst('press the button again'),
          show_alert: true,
        });
        return;
      }
      const draft = await findQuickAddDraft(db, {
        id: action.draftId,
        householdId: household.id,
        now: now(),
      });
      // Saved, cancelled or expired. The card is left as it is: if it was just saved (a double
      // tap), it already says so.
      if (!draft) {
        await ctx.answerCallbackQuery({ text: 'That card is out of date. Send /add again.' });
        return;
      }
      if (draft.memberId !== presser.id) {
        await ctx.answerCallbackQuery({
          text: 'Only the person who sent /add can save or cancel it.',
        });
        return;
      }

      let outcome: { text: string; toast: string };
      if (action.type === 'quickAddCancel') {
        await takeQuickAddDraft(db, { id: draft.id, householdId: household.id, now: now() });
        outcome = { text: renderQuickAddCancelled(draft.task.title), toast: 'Cancelled' };
      } else {
        const result = await saveDraft(deps, household, draft, presser);
        if (result.saved) {
          outcome = {
            text: renderQuickAddSaved(result.saved, result.names, publicBaseUrl),
            toast: '✅ Added',
          };
        } else if (result.reason === 'gone') {
          await ctx.answerCallbackQuery({ text: 'That card is out of date. Send /add again.' });
          return;
        } else {
          outcome = {
            text: renderQuickAddFailed(draft.task.title),
            toast: 'I could not add that.',
          };
        }
      }

      try {
        await ctx.api.editMessageText(
          message.chat.id,
          message.message_id,
          outcome.text,
          NO_BUTTONS,
        );
      } catch (error) {
        logger.error('editing the quick-add card failed', {
          chatId: message.chat.id,
          messageId: message.message_id,
          ...errorFields(error),
        });
      }
      await ctx.answerCallbackQuery({ text: outcome.toast });
    } catch (error) {
      logger.error('quick-add press failed', {
        data: ctx.callbackQuery.data,
        ...errorFields(error),
      });
      await ctx.answerCallbackQuery({ text: 'Something went wrong. Try again.' }).catch(() => {});
    }
  });
}
