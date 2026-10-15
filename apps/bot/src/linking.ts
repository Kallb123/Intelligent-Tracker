import {
  findHouseholdById,
  migrateTelegramGroupChat,
  redeemGroupLinkCode,
  redeemMemberLinkCode,
} from '@tracker/db';
import type { Bot } from 'grammy';
import type { BotDeps } from './deps.js';

/*
 * Linking Telegram to the app (docs/PLAN.md 5.1). The bot only reacts to commands and button
 * presses, so it works with Telegram's privacy mode on (the BotFather default), where a group
 * bot sees nothing else. Anything not handled here, in particular every other message in a group
 * that is not linked, is ignored.
 */

/** " (https://tracker.example)" after "the web app", when the address is configured. */
function webAppHint(publicBaseUrl: string | undefined): string {
  return publicBaseUrl ? ` (${publicBaseUrl})` : '';
}

export function registerLinking(bot: Bot, deps: BotDeps): void {
  const { db, now, logger, publicBaseUrl } = deps;

  // `/linkgroup <code>`: the admin's one-time code from the web app, sent in the house group.
  bot.command('linkgroup', async (ctx) => {
    if (ctx.chat.type === 'private') {
      await ctx.reply(
        'Send /linkgroup <code> in the house group instead. Add me to the group first; ' +
          'the code is in the web app under Settings → Telegram.',
      );
      return;
    }
    const code = ctx.match.trim();
    if (!code) {
      await ctx.reply(
        'Send /linkgroup <code>, with the code from the web app under Settings → Telegram.',
      );
      return;
    }
    const householdId = await redeemGroupLinkCode(db, code, ctx.chat.id, { now: now() });
    if (!householdId) {
      await ctx.reply(
        'That code is not valid, has expired, or this group already belongs to another ' +
          'household. Either way it is used up now: create a new code in the web app under ' +
          'Settings → Telegram and try again.',
      );
      return;
    }
    const household = await findHouseholdById(db, householdId);
    logger.info('group linked', { householdId, chatId: ctx.chat.id });
    await ctx.reply(
      `This group is now linked to ${household?.name ?? 'your household'}. Reminders will be ` +
        'posted here. To press the buttons, everyone connects their own Telegram in the web ' +
        `app${webAppHint(publicBaseUrl)} under Account → Connect Telegram.`,
    );
  });

  // `/start <code>`: the deep link `t.me/<bot>?start=<code>` from a member's "Connect Telegram".
  bot.command('start', async (ctx) => {
    // Only in a private chat; in a group `/start` is not ours to answer.
    if (ctx.chat.type !== 'private' || !ctx.from) return;
    const code = ctx.match.trim();
    const result = code
      ? await redeemMemberLinkCode(db, code, ctx.from.id, { now: now() })
      : undefined;
    if (result?.status === 'linked') {
      logger.info('member linked', { memberId: result.memberId });
      await ctx.reply(
        `You're linked as ${result.name}. Reminders are posted in the house group; press ` +
          `their buttons there and I'll record it as you.`,
      );
      return;
    }
    if (result?.status === 'already_linked') {
      // Not moved: anyone can send someone a link, so it must not take over an existing one.
      await ctx.reply(
        `This Telegram account is already connected to ${result.name}. To connect it to ` +
          `someone else, first disconnect it in the web app${webAppHint(publicBaseUrl)} ` +
          'under Account → Telegram, then open the link again.',
      );
      return;
    }
    await ctx.reply(
      `${code ? 'That link is not valid or has expired. ' : ''}To connect your Telegram, open ` +
        `the web app${webAppHint(publicBaseUrl)}, go to Account → Telegram and press ` +
        'Connect Telegram.',
    );
  });

  // Telegram gives a group a new id when it becomes a supergroup and says so in the old chat.
  bot.on('message:migrate_to_chat_id', async (ctx) => {
    const householdId = await migrateTelegramGroupChat(
      db,
      ctx.chat.id,
      ctx.message.migrate_to_chat_id,
    );
    if (householdId) {
      logger.info('group migrated to a supergroup', {
        householdId,
        from: ctx.chat.id,
        to: ctx.message.migrate_to_chat_id,
      });
    }
  });
}
