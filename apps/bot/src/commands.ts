import { localToday } from '@tracker/core';
import {
  findHouseholdByTelegramChat,
  loadAgenda,
  setMemberAway,
  type Household,
  type Member,
} from '@tracker/db';
import { formatDayHeading, parseUkDate } from '@tracker/shared';
import type { Bot, Context } from 'grammy';
import type { BotDeps } from './deps.js';
import { plain, renderMorningDigest, renderWeekAhead } from './digest.js';
import { sendQuickAddCard } from './quick-add.js';
import { MAX_NAME_LENGTH } from './render.js';
import { linkFirst, memberInHousehold, replyPlain } from './sender.js';

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
  { command: 'add', description: 'Add a job: /add MOT due 14/03, remind me a month before' },
] as const;

/** Words after `/away` that clear the away date. */
const AWAY_OFF = ['off', 'back', 'clear', 'none'];

/** What a command handler gets: the household of the group, and the update. */
type Handler = (ctx: Context, household: Household, args: string) => Promise<void>;

export function registerCommands(bot: Bot, deps: BotDeps): void {
  const { db, now } = deps;

  /** Registers `/name` for the household's group only (see the note at the top). */
  const command = (name: (typeof BOT_COMMANDS)[number]['command'], handler: Handler): void => {
    bot.command(name, async (ctx) => {
      if (ctx.chat.type === 'private') {
        await replyPlain(ctx, `I only answer in the house group. Send /${name} there.`);
        return;
      }
      const household = await findHouseholdByTelegramChat(db, ctx.chat.id);
      if (household) await handler(ctx, household, ctx.match.trim());
    });
  };

  /** The member behind the sender; says to connect Telegram first, and returns null, if none. */
  const senderOf = async (ctx: Context, household: Household): Promise<Member | null> => {
    const member = ctx.from ? await memberInHousehold(db, household, ctx.from.id) : null;
    if (!member) await replyPlain(ctx, linkFirst('send the command again'));
    return member;
  };

  // /today and /digest show the same thing; /digest is the name of what the group gets at 08:00.
  const today: Handler = async (ctx, household) => {
    const agenda = await loadAgenda(db, household, { now: now(), view: 'today' });
    await replyPlain(ctx, renderMorningDigest(agenda, household.timezone) ?? 'Nothing on today.');
  };
  command('today', today);
  command('digest', today);

  command('week', async (ctx, household) => {
    const agenda = await loadAgenda(db, household, { now: now(), view: 'week' });
    await replyPlain(
      ctx,
      renderWeekAhead(agenda, household.timezone) ?? 'Nothing on in the next 7 days.',
    );
  });

  command('mine', async (ctx, household) => {
    const me = await senderOf(ctx, household);
    if (!me) return;
    const agenda = await loadAgenda(db, household, { now: now(), view: 'week', memberId: me.id });
    await replyPlain(
      ctx,
      renderWeekAhead(
        agenda,
        household.timezone,
        `📅 ${plain(me.name, MAX_NAME_LENGTH)}: next 7 days`,
      ) ?? `Nothing on for you in the next 7 days, ${plain(me.name, MAX_NAME_LENGTH)}.`,
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
      await replyPlain(
        ctx,
        `${me.awayUntil ? `You are away until ${formatDayHeading(me.awayUntil, today, true)}.` : 'You are not marked as away.'} ${usage}`,
      );
      return;
    }
    const clearing = AWAY_OFF.includes(args.toLowerCase());
    const until = clearing ? null : parseUkDate(args, today);
    if (!clearing && until === null) {
      await replyPlain(ctx, `I could not read "${plain(args, 40)}" as a date. ${usage}`);
      return;
    }
    if (until !== null && until < today) {
      await replyPlain(ctx, `${formatDayHeading(until, today, true)} has already passed. ${usage}`);
      return;
    }
    await db.transaction((tx) =>
      setMemberAway(tx, {
        householdId: household.id,
        actorId: me.id,
        memberId: me.id,
        awayUntil: until,
        now: at,
      }),
    );
    await replyPlain(
      ctx,
      until
        ? `Got it, ${plain(me.name, MAX_NAME_LENGTH)}: you are away until ${formatDayHeading(until, today, true)}. ` +
            'Rotating jobs skip you until then.'
        : `Welcome back, ${plain(me.name, MAX_NAME_LENGTH)}. You are no longer marked as away.`,
    );
  });

  // Understanding the text and asking for a Save is `quick-add.ts`.
  command('add', async (ctx, household, args) => {
    const me = await senderOf(ctx, household);
    if (!me) return;
    if (args === '') {
      await replyPlain(
        ctx,
        'Send /add and the job, for example: /add Car insurance renews 1/11 every year, sort it a month before',
      );
      return;
    }
    await sendQuickAddCard(ctx, deps, household, me, args.replace(/\s+/g, ' '));
  });
}
