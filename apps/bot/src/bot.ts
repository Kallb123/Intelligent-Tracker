import type { Database } from '@tracker/db';
import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { registerActions } from './actions.js';
import { registerCommands } from './commands.js';
import type { BotDeps } from './deps.js';
import { registerLinking } from './linking.js';
import { errorFields, silentLogger } from './logger.js';
import { registerQuickAdd } from './quick-add.js';
import { registerSuggestions } from './suggestions.js';

/**
 * The update types the bot handles, so Telegram does not send it any other. Commands arrive as
 * `message`, button presses as `callback_query`. (Group privacy mode, a BotFather setting that
 * is on by default, further limits what a group's `message` updates contain to commands, replies
 * to the bot and mentions; the bot is written to work that way and never needs it turned off.)
 */
export const BOT_ALLOWED_UPDATES = ['message', 'callback_query'] as const;

export interface CreateBotOptions {
  token: string;
  /** The bot's own identity. Given in tests; otherwise grammY asks Telegram (`getMe`) on start. */
  botInfo?: UserFromGetMe;
  now?: () => Date;
  logger?: BotDeps['logger'];
  publicBaseUrl?: string | undefined;
}

/** The handlers' dependencies for these options; the caller also hands them to the delivery loop. */
export function botDeps(
  db: Database,
  options: Omit<CreateBotOptions, 'token' | 'botInfo'>,
): BotDeps {
  return {
    db,
    now: options.now ?? (() => new Date()),
    logger: options.logger ?? silentLogger,
    publicBaseUrl: options.publicBaseUrl,
  };
}

/**
 * Builds the bot with its handlers: linking commands, the group commands and button presses. Starting it (long
 * polling) and delivering reminders are left to the caller, so tests can feed it updates with
 * `bot.handleUpdate` and swap the Telegram API out with `bot.api.config.use`.
 */
export function createBot(db: Database, options: CreateBotOptions): Bot {
  const bot = new Bot(options.token, options.botInfo ? { botInfo: options.botInfo } : {});
  const deps = botDeps(db, options);

  bot.catch(({ ctx, error }) =>
    deps.logger.error('update failed', { updateId: ctx.update.update_id, ...errorFields(error) }),
  );
  registerLinking(bot, deps);
  // Before the reminder buttons' handler, which treats any other button data as out of date.
  registerQuickAdd(bot, deps);
  registerSuggestions(bot, deps);
  registerActions(bot, deps);
  registerCommands(bot, deps);
  return bot;
}
