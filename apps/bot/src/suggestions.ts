import {
  findHouseholdByTelegramChat,
  listSuggestions,
  resolveSuggestion,
  type Household,
} from '@tracker/db';
import { suggestionIdSchema } from '@tracker/shared';
import type { Bot, Context } from 'grammy';
import type { BotDeps } from './deps.js';
import { plain } from './digest.js';
import { errorFields } from './logger.js';
import { linkFirst, memberInHousehold, NO_PREVIEW, replyPlain } from './sender.js';

/** A bounded page of cards; later cards become visible as these are accepted or dismissed. */
export async function sendSuggestions(
  ctx: Context,
  deps: BotDeps,
  household: Household,
): Promise<void> {
  const suggestions = await listSuggestions(deps.db, household.id, deps.now());
  if (suggestions.length === 0) {
    await replyPlain(
      ctx,
      'No suggestions right now. Repeating tasks need some completion history first.',
    );
    return;
  }
  for (const suggestion of suggestions.slice(0, 5)) {
    await ctx.reply(`${plain(suggestion.title, 200)}\n\n${plain(suggestion.message, 1500)}`, {
      ...NO_PREVIEW,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Accept', callback_data: `sa:${suggestion.id}` },
            { text: '✖️ Dismiss', callback_data: `sd:${suggestion.id}` },
          ],
        ],
      },
    });
  }
  if (suggestions.length > 5) {
    await replyPlain(
      ctx,
      `${suggestions.length - 5} more suggestions. Accept or dismiss these, then send /suggestions again, or open Suggestions in the app.`,
    );
  }
}

export function registerSuggestions(bot: Bot, deps: BotDeps): void {
  bot.callbackQuery(/^s[ad]:/, async (ctx) => {
    const message = ctx.callbackQuery.message;
    const id = ctx.callbackQuery.data.slice(3);
    if (!message || !suggestionIdSchema.safeParse(id).success) {
      await ctx.answerCallbackQuery({ text: 'That button is out of date.' });
      return;
    }
    try {
      const household = await findHouseholdByTelegramChat(deps.db, message.chat.id);
      if (!household) {
        await ctx.answerCallbackQuery();
        return;
      }
      const member = await memberInHousehold(deps.db, household, ctx.from.id);
      if (!member) {
        await ctx.answerCallbackQuery({
          text: linkFirst('press the button again'),
          show_alert: true,
        });
        return;
      }
      const action = ctx.callbackQuery.data.startsWith('sa:') ? 'accept' : 'dismiss';
      const changed = await resolveSuggestion(deps.db, {
        householdId: household.id,
        memberId: member.id,
        id,
        action,
        now: deps.now(),
      });
      if (!changed) {
        await ctx.answerCallbackQuery({
          text: 'That suggestion is out of date. Send /suggestions again.',
        });
        return;
      }
      const text =
        action === 'accept' ? '✅ Suggestion accepted. Task updated.' : '✖️ Suggestion dismissed.';
      // Database success remains success even if Telegram cannot edit the original card.
      try {
        await ctx.api.editMessageText(message.chat.id, message.message_id, text, {
          ...NO_PREVIEW,
          reply_markup: { inline_keyboard: [] },
        });
      } catch (error) {
        deps.logger.error('editing suggestion card failed', errorFields(error));
      }
      await ctx.answerCallbackQuery({ text });
    } catch (error) {
      deps.logger.error('suggestion press failed', errorFields(error));
      await ctx.answerCallbackQuery({ text: 'Something went wrong. Try again.' }).catch(() => {});
    }
  });
}
