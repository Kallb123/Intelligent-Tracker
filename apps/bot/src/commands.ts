import { localToday } from '@tracker/core';
import {
  createTask,
  findHouseholdByTelegramChat,
  loadAgenda,
  setMemberAway,
  type Household,
  type Member,
} from '@tracker/db';
import { formatDayHeading, parseUkDate } from '@tracker/shared';
import type { Bot, Context } from 'grammy';
import type { BotDeps } from './deps.js';
import { renderMorningDigest, renderWeekAhead } from './digest.js';
import { truncate } from './render.js';
import { linkFirst, memberInHousehold } from './sender.js';

/*
 * The slash commands for the house group: what is on (/today, /week, /mine, /digest) and the two
 * things a member can do from the chat (/away, /add). Like the buttons, they only work in the
 * household's linked group; in a private chat the bot says where to go instead, and in any other
 * group it stays silent. The ones that act as a person (/mine, /away, /add) need the sender to
 * have connected Telegram to a member of this household.
 *
 * What the lists say is `digest.ts`, the same text the scheduled digests use. They are plain
 * text without mentions, so a command never pings anyone.
 */

/** The commands in Telegram's command menu (`setMyCommands`), and so the ones registered below. */
export const BOT_COMMANDS = [
  { command: 'today', description: "What's on today" },
  { command: 'week', description: 'What is on in the next 7 days' },
  { command: 'mine', description: 'Your jobs in the next 7 days' },
  { command: 'digest', description: "Post this morning's digest" },
  { command: 'away', description: 'Set when you are away until: /away 24/12, or /away off' },
  { command: 'add', description: 'Add a job for yourself: /add Buy bin bags' },
] as const;

/** The most characters a task title may have; the api's limit. */
const MAX_TITLE_LENGTH = 200;

/** Words after `/away` that clear the away date. */
const AWAY_OFF = ['off', 'back', 'clear', 'none'];

const NO_PREVIEW = { link_preview_options: { is_disabled: true } } as const;

/** What a command handler gets: the household of the group, and the update. */
type Handler = (ctx: Context, household: Household, args: string) => Promise<void>;

export function registerCommands(bot: Bot, deps: BotDeps): void {
  const { db, now, publicBaseUrl } = deps;

  /** Registers `/name` for the household's group only (see the note at the top). */
  const command = (name: (typeof BOT_COMMANDS)[number]['command'], handler: Handler): void => {
    bot.command(name, async (ctx) => {
      if (ctx.chat.type === 'private') {
        await ctx.reply(`I only answer in the house group. Send /${name} there.`);
        return;
      }
      const household = await findHouseholdByTelegramChat(db, ctx.chat.id);
      if (household) await handler(ctx, household, ctx.match.trim());
    });
  };

  /** The member behind the sender; says to connect Telegram first, and returns null, if none. */
  const senderOf = async (ctx: Context, household: Household): Promise<Member | null> => {
    const member = ctx.from ? await memberInHousehold(db, household, ctx.from.id) : null;
    if (!member) await ctx.reply(linkFirst('send the command again'));
    return member;
  };

  // /today and /digest show the same thing; /digest is the name of what the group gets at 08:00.
  const today: Handler = async (ctx, household) => {
    const agenda = await loadAgenda(db, household, { now: now(), view: 'today' });
    await ctx.reply(renderMorningDigest(agenda, household.timezone) ?? 'Nothing on today.');
  };
  command('today', today);
  command('digest', today);

  command('week', async (ctx, household) => {
    const agenda = await loadAgenda(db, household, { now: now(), view: 'week' });
    await ctx.reply(
      renderWeekAhead(agenda, household.timezone) ?? 'Nothing on in the next 7 days.',
    );
  });

  command('mine', async (ctx, household) => {
    const me = await senderOf(ctx, household);
    if (!me) return;
    const agenda = await loadAgenda(db, household, { now: now(), view: 'week', memberId: me.id });
    await ctx.reply(
      renderWeekAhead(agenda, household.timezone, `📅 ${truncate(me.name, 40)}: next 7 days`) ??
        `Nothing on for you in the next 7 days, ${me.name}.`,
    );
  });

  command('away', async (ctx, household, args) => {
    const me = await senderOf(ctx, household);
    if (!me) return;
    const at = now();
    const today = localToday(at, household.timezone);
    const usage =
      'Send /away 24/12 to be away until that date (including it), or /away off to be back.';

    if (args === '') {
      await ctx.reply(
        `${me.awayUntil ? `You are away until ${formatDayHeading(me.awayUntil, today, true)}.` : 'You are not marked as away.'} ${usage}`,
      );
      return;
    }
    const clearing = AWAY_OFF.includes(args.toLowerCase());
    const until = clearing ? null : parseUkDate(args, today);
    if (!clearing && until === null) {
      await ctx.reply(`I could not read "${truncate(args, 40)}" as a date. ${usage}`);
      return;
    }
    if (until !== null && until < today) {
      await ctx.reply(`${formatDayHeading(until, today, true)} has already passed. ${usage}`);
      return;
    }
    await setMemberAway(db, {
      householdId: household.id,
      actorId: me.id,
      memberId: me.id,
      awayUntil: until,
      now: at,
    });
    await ctx.reply(
      until
        ? `Got it, ${me.name}: you are away until ${formatDayHeading(until, today, true)}. ` +
            'Rotating jobs skip you until then.'
        : `Welcome back, ${me.name}. You are no longer marked as away.`,
    );
  });

  // A bare one-off job for the sender. Understanding "MOT due 14/03, remind me a month before"
  // and confirming it with a card is the rule-based quick-add of PR 17; until then the date is
  // set in the app.
  command('add', async (ctx, household, args) => {
    const me = await senderOf(ctx, household);
    if (!me) return;
    if (args === '') {
      await ctx.reply('Send /add and the job, for example: /add Buy bin bags');
      return;
    }
    const title = truncate(args.replace(/\s+/g, ' '), MAX_TITLE_LENGTH);
    const created = await db.transaction((tx) =>
      createTask(tx, {
        householdId: household.id,
        createdBy: me.id,
        values: {
          title,
          scheduleKind: 'once',
          allDay: true,
          assignmentMode: 'fixed',
          reminderProfile: household.defaultReminderProfile,
        },
        assigneeIds: [me.id],
        milestones: [],
        now: now(),
      }),
    );
    await ctx.reply(
      `Added "${title}" for ${me.name}.` +
        (publicBaseUrl ? ` Set a date in the app: ${publicBaseUrl}/tasks/${created.id}` : ''),
      NO_PREVIEW,
    );
  });
}
