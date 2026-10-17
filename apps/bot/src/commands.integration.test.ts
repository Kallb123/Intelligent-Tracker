import { bankHoliday, member, quickAddDraft, task } from '@tracker/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_COMMANDS } from './commands.js';
import {
  adminUrl,
  CHAT_ID,
  commandUpdate,
  newHousehold,
  newMember,
  newOccurrence,
  newTestBot,
  useTestDatabase,
} from './test-harness.js';

const ALEX = 1001;
const STRANGER = 4242;

describe.skipIf(!adminUrl)('group commands (integration)', () => {
  const test = useTestDatabase();
  // Bank holidays are shared by all households, so deleting a household does not clear them.
  beforeEach(async () => {
    await test.db.delete(bankHoliday);
  });

  const send = (text: string, options: { chatId?: number; fromId?: number } = {}) =>
    commandUpdate({
      chatId: options.chatId ?? CHAT_ID,
      chatType: 'supergroup',
      fromId: options.fromId ?? ALEX,
      text,
    });

  /** The default household with Alex linked, and a bot on it. */
  async function setup(botOptions: Parameters<typeof newTestBot>[1] = {}) {
    const h = await newHousehold(test.db);
    const alex = await newMember(test.db, h.id, 'Alex', ALEX);
    return { h, alex, ...newTestBot(test.db, botOptions) };
  }

  describe('/today and /digest', () => {
    it('lists the household’s jobs in sections, and its region’s bank holidays, as plain text', async () => {
      const { h, alex, bot, telegram } = await setup();
      const other = await newHousehold(test.db, { name: 'Elsewhere', telegramGroupChatId: -999 });
      await newOccurrence(test.db, h.id, 'Clean the gutters', {
        assigneeId: alex.id,
        dueDate: '2026-10-30',
      });
      await newOccurrence(test.db, h.id, 'Put the <bins> out');
      await newOccurrence(test.db, other.id, 'Private chore');
      await test.db.insert(bankHoliday).values([
        { region: 'england-and-wales', date: '2026-11-05', title: 'Test bank holiday' },
        { region: 'scotland', date: '2026-11-05', title: 'Scottish holiday' },
      ]);

      await bot.handleUpdate(send('/today'));

      expect(telegram.sentTexts).toEqual([
        [
          '☀️ Mon 2 Nov',
          '',
          'Overdue',
          '• Clean the gutters — Alex (3 days overdue)',
          '',
          'Today',
          '• Put the <bins> out — Anyone',
          '',
          'Bank holiday Thu 5 Nov: Test bank holiday. Bin collection may be a day late.',
        ].join('\n'),
      ]);
      // Plain text: no parse mode, so the "<bins>" is not markup.
      expect(telegram.to('sendMessage')[0]).not.toHaveProperty('parse_mode');

      // /digest is the same text.
      await bot.handleUpdate(send('/digest'));
      expect(telegram.sentTexts[1]).toBe(telegram.sentTexts[0]);
    });

    it('says there is nothing on, from anyone, even a Telegram user who is not linked', async () => {
      const { bot, telegram } = await setup();
      await bot.handleUpdate(send('/today', { fromId: STRANGER }));
      await bot.handleUpdate(send('/digest'));
      expect(telegram.sentTexts).toEqual(['Nothing on today.', 'Nothing on today.']);
    });
  });

  describe('/week and /mine', () => {
    it('/week groups the next 7 days by day, with the overdue first', async () => {
      const { h, alex, bot, telegram } = await setup();
      await newOccurrence(test.db, h.id, 'Old job', { dueDate: '2026-11-01' });
      await newOccurrence(test.db, h.id, 'Bins', { assigneeId: alex.id, dueDate: '2026-11-04' });
      await newOccurrence(test.db, h.id, 'Next month', { dueDate: '2026-12-25' });

      await bot.handleUpdate(send('/week'));

      expect(telegram.sentTexts).toEqual([
        [
          '📅 Week ahead',
          '',
          'Overdue',
          '• Old job — Anyone (1 day overdue)',
          '',
          'Wed 4 Nov',
          '• Bins — Alex',
        ].join('\n'),
      ]);
    });

    it('sends none of the lists with a link preview', async () => {
      const { bot, telegram } = await setup();
      for (const command of ['/today', '/digest', '/week', '/mine']) {
        await bot.handleUpdate(send(command));
      }
      const sent = telegram.to('sendMessage');
      expect(sent).toHaveLength(4);
      for (const payload of sent) {
        expect(payload).toMatchObject({ link_preview_options: { is_disabled: true } });
      }
    });

    it('/week says so when there is nothing on', async () => {
      const { bot, telegram } = await setup();
      await bot.handleUpdate(send('/week'));
      expect(telegram.sentTexts).toEqual(['Nothing on in the next 7 days.']);
    });

    it('/mine lists only the sender’s own jobs, headed with their name', async () => {
      const { h, alex, bot, telegram } = await setup();
      const sam = await newMember(test.db, h.id, 'Sam', 1002);
      await newOccurrence(test.db, h.id, 'Alex job', { assigneeId: alex.id });
      await newOccurrence(test.db, h.id, 'Sam job', { assigneeId: sam.id });
      await newOccurrence(test.db, h.id, 'Anyone job');

      await bot.handleUpdate(send('/mine'));
      await bot.handleUpdate(send('/mine', { fromId: 1002 }));

      expect(telegram.sentTexts).toEqual([
        '📅 Alex: next 7 days\n\nMon 2 Nov\n• Alex job — Alex',
        '📅 Sam: next 7 days\n\nMon 2 Nov\n• Sam job — Sam',
      ]);
    });

    it('/mine defuses an @ in the sender’s name, in the heading and when there is nothing on', async () => {
      const { h, bot, telegram } = await setup();
      const sam = await newMember(test.db, h.id, '@everyone Sam', 1002);
      await bot.handleUpdate(send('/mine', { fromId: 1002 }));
      await newOccurrence(test.db, h.id, 'Sam job', { assigneeId: sam.id });
      await bot.handleUpdate(send('/mine', { fromId: 1002 }));

      expect(telegram.sentTexts).toEqual([
        'Nothing on for you in the next 7 days, @\u200beveryone Sam.',
        expect.stringMatching(/^📅 @\u200beveryone Sam: next 7 days\n/),
      ]);
    });

    it('/mine says so when there is nothing for the sender', async () => {
      const { bot, telegram } = await setup();
      await bot.handleUpdate(send('/mine'));
      expect(telegram.sentTexts).toEqual(['Nothing on for you in the next 7 days, Alex.']);
    });
  });

  describe('/away', () => {
    const awayUntil = async (id: string) =>
      (await test.db.select().from(member).where(eq(member.id, id)))[0]?.awayUntil;

    it('sets the date, including the year when it is not this one, and clears it', async () => {
      const { alex, bot, telegram } = await setup();

      await bot.handleUpdate(send('/away 24/12'));
      expect(await awayUntil(alex.id)).toBe('2026-12-24');
      expect(telegram.sentTexts[0]).toBe(
        'Got it, Alex: you are away until Thu 24 Dec 2026. Rotating jobs skip you until then.',
      );

      await bot.handleUpdate(send('/away 5/1/27'));
      expect(await awayUntil(alex.id)).toBe('2027-01-05');

      await bot.handleUpdate(send('/away'));
      expect(telegram.sentTexts[2]).toBe(
        'You are away until Tue 5 Jan 2027. Send /away 24/12 to be away until that date ' +
          '(including it), or /away off to be back.',
      );

      for (const word of ['off', 'BACK', 'clear', 'none']) {
        await bot.handleUpdate(send('/away 1/1/2027'));
        await bot.handleUpdate(send(`/away ${word}`));
        expect(await awayUntil(alex.id)).toBeNull();
      }
      expect(telegram.sentTexts.at(-1)).toBe(
        'Welcome back, Alex. You are no longer marked as away.',
      );
    });

    it('sets and replans in one transaction', async () => {
      const { bot } = await setup();
      const transaction = vi.spyOn(test.db, 'transaction');
      await bot.handleUpdate(send('/away 24/12'));
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it('shows that you are not away, and accepts today', async () => {
      const { alex, bot, telegram } = await setup();
      await bot.handleUpdate(send('/away'));
      expect(telegram.sentTexts[0]).toMatch(/^You are not marked as away\. Send \/away 24\/12/);
      await bot.handleUpdate(send('/away 2/11'));
      expect(await awayUntil(alex.id)).toBe('2026-11-02');
    });

    it('refuses a past date and text that is not a date, and changes nothing', async () => {
      const { alex, bot, telegram } = await setup();
      await bot.handleUpdate(send('/away 1/11/2026'));
      await bot.handleUpdate(send('/away next week'));
      await bot.handleUpdate(send('/away 31/02'));

      expect(telegram.sentTexts[0]).toMatch(/^Sun 1 Nov 2026 has already passed\. Send \/away/);
      expect(telegram.sentTexts[1]).toMatch(/^I could not read "next week" as a date\./);
      expect(telegram.sentTexts[2]).toMatch(/^I could not read "31\/02" as a date\./);
      expect(await awayUntil(alex.id)).toBeNull();
    });
  });

  describe('/add', () => {
    const USAGE =
      'Send /add and the job, for example: /add Car insurance renews 1/11 every year, sort it a month before';

    it('replies with a confirmation card for the sender, and adds nothing yet', async () => {
      const { h, alex, bot, telegram } = await setup();

      await bot.handleUpdate(send('/add   Buy   bin bags every Tuesday '));

      expect(await test.db.select().from(task).where(eq(task.householdId, h.id))).toEqual([]);
      expect(telegram.sentTexts).toEqual([
        [
          'Add this job?',
          '',
          'Buy bin bags',
          'When: Tue 3 Nov',
          'Repeats: Every week on Tuesday',
          'For: Alex',
        ].join('\n'),
      ]);
      const [draft] = await test.db.select().from(quickAddDraft);
      expect(draft).toMatchObject({ householdId: h.id, memberId: alex.id });
    });

    it('explains how to use it, and keeps no draft, without a title', async () => {
      const { bot, telegram } = await setup();
      await bot.handleUpdate(send('/add'));
      await bot.handleUpdate(send('/add    '));

      expect(telegram.sentTexts).toEqual([USAGE, USAGE]);
      expect(await test.db.select().from(quickAddDraft)).toEqual([]);
    });
  });

  describe('where they work', () => {
    const linkFirst =
      'Connect your Telegram first: in the web app, go to Account → Connect Telegram. ' +
      'Then send the command again.';

    it('registers every command in BOT_COMMANDS, and answers each in the linked group', async () => {
      const { bot, telegram } = await setup();
      for (const { command } of BOT_COMMANDS) {
        const before = telegram.sentTexts.length;
        await bot.handleUpdate(send(`/${command}`));
        expect(telegram.sentTexts.length, command).toBe(before + 1);
      }
    });

    it('lists commands Telegram accepts for its menu', () => {
      for (const { command, description } of BOT_COMMANDS) {
        expect(command).toMatch(/^[a-z]{1,32}$/);
        expect(description.length).toBeGreaterThanOrEqual(3);
        expect(description.length).toBeLessThanOrEqual(256);
      }
      expect(new Set(BOT_COMMANDS.map((c) => c.command)).size).toBe(BOT_COMMANDS.length);
    });

    it('points to the house group from a private chat, without doing anything', async () => {
      const { h, bot, telegram } = await setup();
      for (const { command } of BOT_COMMANDS) {
        await bot.handleUpdate(
          commandUpdate({ chatId: ALEX, chatType: 'private', fromId: ALEX, text: `/${command} x` }),
        );
      }
      expect(telegram.sentTexts).toEqual(
        BOT_COMMANDS.map(
          ({ command }) => `I only answer in the house group. Send /${command} there.`,
        ),
      );
      expect(await test.db.select().from(task).where(eq(task.householdId, h.id))).toEqual([]);
    });

    it('stays silent in a group that is not linked', async () => {
      const { bot, telegram } = await setup();
      for (const { command } of BOT_COMMANDS) {
        await bot.handleUpdate(send(`/${command} x`, { chatId: -123456 }));
      }
      expect(telegram.calls).toEqual([]);
    });

    it('asks a sender who is not connected to connect Telegram, for the commands that act as a member', async () => {
      const { bot, telegram } = await setup();
      for (const text of ['/mine', '/away 24/12', '/add Hoover']) {
        await bot.handleUpdate(send(text, { fromId: STRANGER }));
      }
      expect(telegram.sentTexts).toEqual([linkFirst, linkFirst, linkFirst]);
    });

    it('does not take a member of another household for a member of this one', async () => {
      const { h, bot, telegram } = await setup();
      const elsewhere = await newHousehold(test.db, {
        name: 'Elsewhere',
        telegramGroupChatId: -999,
      });
      await newMember(test.db, elsewhere.id, 'Jo', 2002);

      await bot.handleUpdate(send('/add Hoover', { fromId: 2002 }));

      expect(telegram.sentTexts).toEqual([linkFirst]);
      expect(await test.db.select().from(task).where(eq(task.householdId, h.id))).toEqual([]);
    });
  });
});
