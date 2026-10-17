import {
  AGENDA_LIMIT,
  findHouseholdByTelegramChat,
  loadAgenda,
  type Agenda,
  type Database,
} from '@tracker/db';
import { formatDayHeading } from '@tracker/shared';
import type { Bot } from 'grammy';
import type { BotDeps } from './deps.js';
import { TELEGRAM_MESSAGE_LIMIT, truncate } from './render.js';

export type Digest = Agenda;

/** Plain text: task and feed titles cannot inject Telegram markup. */
export function renderDigest(digest: Digest): string {
  return truncate(
    [
      `Household digest — ${formatDayHeading(digest.today)}`,
      ...digest.items.map((job) => `• ${truncate(job.title, 160)}`),
      ...(digest.items.length ? [] : ['No active jobs today.']),
      ...(digest.items.length === AGENDA_LIMIT ? ['See the app for all jobs.'] : []),
      ...digest.holidays.map(
        (holiday) =>
          `Bank holiday ${formatDayHeading(holiday.date)}: ${truncate(holiday.title, 120)}. Bin collection may be a day late.`,
      ),
    ].join('\n'),
    TELEGRAM_MESSAGE_LIMIT,
  );
}

export async function householdDigest(
  db: Database,
  chatId: number,
  now: Date,
): Promise<string | null> {
  const h = await findHouseholdByTelegramChat(db, chatId);
  return h ? renderDigest(await loadAgenda(db, h, { now, view: 'today' })) : null;
}

/** The PR 13 command suite can reuse this cached holiday-aware digest. */
export function registerDigest(bot: Bot, deps: BotDeps): void {
  bot.command('digest', async (ctx) => {
    if (ctx.chat.type === 'private') return;
    const text = await householdDigest(deps.db, ctx.chat.id, deps.now());
    if (text) await ctx.reply(text);
  });
}
