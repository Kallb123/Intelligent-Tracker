import {
  household,
  member,
  occurrence,
  quickAddDraft,
  task,
  taskAssignee,
  taskMilestone,
} from '@tracker/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  adminUrl,
  CHAT_ID,
  commandUpdate,
  newHousehold,
  newMember,
  newTestBot,
  NOW,
  pressUpdate,
  useTestDatabase,
} from './test-harness.js';

const ALEX_TG = 1001;
const SAM_TG = 2002;
const STRANGER = 4242;
const CAR_INSURANCE = 'Car insurance renews 1/11 every year, sort it a month before';

interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

/** The buttons the bot sent or edited a message with, in rows. */
const buttonsOf = (payload: Record<string, unknown> | undefined): Button[][] =>
  (payload?.['reply_markup'] as { inline_keyboard: Button[][] }).inline_keyboard;

describe.skipIf(!adminUrl)('/add confirmation cards (integration)', () => {
  const test = useTestDatabase();

  /** A household with a linked group and two linked members, and a bot on it. */
  async function setup(botOptions: Parameters<typeof newTestBot>[1] = {}) {
    const h = await newHousehold(test.db);
    const alex = await newMember(test.db, h.id, 'Alex', ALEX_TG);
    const sam = await newMember(test.db, h.id, 'Sam', SAM_TG);
    const harness = newTestBot(test.db, botOptions);
    const { bot, telegram } = harness;

    /** Alex (or `fromId`) sends `/add text`; returns the card's message id and its buttons. */
    const add = async (text: string, fromId = ALEX_TG) => {
      const before = telegram.to('sendMessage').length;
      await bot.handleUpdate(
        commandUpdate({ chatId: CHAT_ID, chatType: 'supergroup', fromId, text: `/add ${text}` }),
      );
      // The last one: a send that Telegram refused is recorded too, and the retry follows it.
      const card = telegram.to('sendMessage').at(-1);
      // The fake numbers messages from 1001.
      return { messageId: 1001 + before, buttons: card ? buttonsOf(card).flat() : [] };
    };
    const press = (
      data: string,
      messageId: number,
      options: { fromId?: number; chatId?: number } = {},
    ) =>
      bot.handleUpdate(
        pressUpdate({
          chatId: options.chatId ?? CHAT_ID,
          messageId,
          fromId: options.fromId ?? ALEX_TG,
          data,
        }),
      );
    const tasks = () => test.db.select().from(task).where(eq(task.householdId, h.id));
    const drafts = () => test.db.select().from(quickAddDraft);
    const toasts = () => telegram.to('answerCallbackQuery');
    return { h, alex, sam, add, press, tasks, drafts, toasts, ...harness };
  }

  describe('the card', () => {
    it('shows what was understood, and saves nothing until Save is pressed', async () => {
      const { h, alex, add, tasks, drafts, telegram } = await setup();

      const { buttons } = await add(CAR_INSURANCE);

      expect(telegram.sentTexts).toEqual([
        [
          'Add this job?',
          '',
          'Car insurance renews',
          'When: Mon 1 Nov 2027',
          'Repeats: Every year on 1 November',
          'Prep starts: 30 days before (Sat 2 Oct 2027)',
          'Milestones: Get quotes (30 days before), Decide (14 days before), Renew (7 days before)',
          'For: Alex',
          'Template: Car insurance renewal',
        ].join('\n'),
      ]);
      // Plain text without a link preview, so nothing a person typed is markup or expands.
      expect(telegram.to('sendMessage')[0]).toMatchObject({
        link_preview_options: { is_disabled: true },
      });
      expect(telegram.to('sendMessage')[0]).not.toHaveProperty('parse_mode');
      expect(buttons.map((b) => b.text)).toEqual(['✅ Save', '✖️ Cancel']);
      for (const button of buttons) {
        expect(Buffer.byteLength(button.callback_data as string)).toBeLessThanOrEqual(64);
      }

      expect(await tasks()).toEqual([]);
      const [draft] = await drafts();
      expect(draft).toMatchObject({
        householdId: h.id,
        memberId: alex.id,
        telegramChatId: CHAT_ID,
        telegramMessageId: 1001,
        createdAt: NOW,
        task: {
          title: 'Car insurance renews',
          rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYMONTHDAY=1',
          leadTimeDays: 30,
          assigneeIds: [alex.id],
        },
      });
      expect(buttons.map((b) => b.callback_data)).toEqual([`qs:${draft?.id}`, `qc:${draft?.id}`]);
    });

    it('adds an Edit in app link to the original text when the app’s address is known', async () => {
      const { add } = await setup({ publicBaseUrl: 'https://tracker.example' });

      const { buttons } = await add('Hoover   the stairs & hall');

      expect(buttons.map((b) => b.text)).toEqual(['✅ Save', '✏️ Edit in app', '✖️ Cancel']);
      const edit = buttons[1] as Button;
      expect(edit).not.toHaveProperty('callback_data');
      expect(edit.url).toBe('https://tracker.example/?quickAdd=Hoover%20the%20stairs%20%26%20hall');
    });

    it('sends the card without the link when Telegram refuses the link button', async () => {
      const { add, telegram, drafts, logger } = await setup({
        publicBaseUrl: 'http://localhost:8080',
      });
      telegram.failNext('sendMessage', { error_code: 400, description: 'Bad Request: wrong URL' });

      const { buttons } = await add('Hoover');

      expect(buttons.map((b) => b.text)).toEqual(['✅ Save', '✖️ Cancel']);
      expect(logger.warnings).toEqual(['quick-add card refused with its link, sending without']);
      expect(await drafts()).toHaveLength(1);
    });

    it('keeps no draft when the card cannot be sent', async () => {
      const { add, telegram, drafts } = await setup();
      telegram.failNext('sendMessage');

      await expect(add('Hoover')).rejects.toThrow('boom');

      expect(await drafts()).toEqual([]);
    });

    it('defuses an @ in the title and in the names, and escapes nothing', async () => {
      const { alex, add, telegram } = await setup();
      await test.db.update(member).set({ name: '@alex<b>' }).where(eq(member.id, alex.id));

      await add('Ask @bob about <b>bins</b> & more');

      const [text] = telegram.sentTexts;
      expect(text).toContain('Ask @\u200bbob about <b>bins</b> & more');
      expect(text).toContain('For: @\u200balex<b>');
      expect(text).not.toMatch(/@(?!\u200b)/);
    });

    it('cuts a long title to the 200 characters the app allows', async () => {
      const { add, telegram } = await setup();

      await add('x'.repeat(300));

      const lines = (telegram.sentTexts[0] as string).split('\n');
      expect(lines[2]).toBe('x'.repeat(200));
    });
  });

  describe('Save', () => {
    it('creates the task as parsed, once, and edits the card in place without buttons', async () => {
      const { alex, add, press, tasks, drafts, telegram, toasts } = await setup({
        publicBaseUrl: 'https://tracker.example',
      });
      const { messageId, buttons } = await add(CAR_INSURANCE);
      telegram.clear();

      await press(buttons[0]?.callback_data as string, messageId);

      const [created] = await tasks();
      expect(created).toMatchObject({
        title: 'Car insurance renews',
        scheduleKind: 'fixed',
        allDay: true,
        dueDate: '2027-11-01',
        rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYMONTHDAY=1',
        leadTimeDays: 30,
        category: 'Car',
        // The template's profile, which the household's default would not override.
        reminderProfile: 'standard',
        createdBy: alex.id,
      });
      expect(
        await test.db
          .select()
          .from(taskAssignee)
          .where(eq(taskAssignee.taskId, created?.id as string)),
      ).toMatchObject([{ memberId: alex.id }]);
      const milestones = await test.db
        .select()
        .from(taskMilestone)
        .where(eq(taskMilestone.taskId, created?.id as string));
      expect(milestones.map((m) => [m.title, m.offsetDaysBeforeDue])).toEqual([
        ['Get quotes', 30],
        ['Decide', 14],
        ['Renew', 7],
      ]);
      expect(
        await test.db
          .select()
          .from(occurrence)
          .where(eq(occurrence.taskId, created?.id as string)),
      ).not.toHaveLength(0);
      expect(await drafts()).toEqual([]);

      expect(telegram.to('sendMessage')).toEqual([]);
      expect(telegram.to('editMessageText')).toEqual([
        {
          chat_id: CHAT_ID,
          message_id: messageId,
          text: `✅ Added "Car insurance renews" for Alex.\nhttps://tracker.example/tasks/${created?.id}`,
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: [] },
        },
      ]);
      expect(toasts()).toMatchObject([{ text: '✅ Added' }]);
    });

    it('uses the household’s default reminder profile when nothing set one', async () => {
      const { h, add, press, tasks } = await setup();
      await test.db
        .update(household)
        .set({ defaultReminderProfile: 'persistent' })
        .where(eq(household.id, h.id));
      const { messageId, buttons } = await add('Hoover the stairs');

      await press(buttons[0]?.callback_data as string, messageId);

      expect(await tasks()).toMatchObject([
        { title: 'Hoover the stairs', scheduleKind: 'once', reminderProfile: 'persistent' },
      ]);
    });

    it('assigns the member named in the text, and says so', async () => {
      const { alex, sam, add, press, tasks, telegram } = await setup();
      const { messageId, buttons } = await add('Hoover the stairs @Sam');
      expect(telegram.sentTexts[0]).toContain('For: Sam');
      telegram.clear();

      await press(buttons[0]?.callback_data as string, messageId);

      const [created] = await tasks();
      expect(created).toMatchObject({ title: 'Hoover the stairs', createdBy: alex.id });
      expect(
        await test.db
          .select()
          .from(taskAssignee)
          .where(eq(taskAssignee.taskId, created?.id as string)),
      ).toMatchObject([{ memberId: sam.id }]);
      expect(telegram.to('editMessageText')[0]).toMatchObject({
        text: '✅ Added "Hoover the stairs" for Sam.',
      });
    });

    it('falls back to the author when the member named has gone since', async () => {
      const { alex, sam, add, press, tasks } = await setup();
      const { messageId, buttons } = await add('Hoover the stairs @Sam');
      await test.db.delete(member).where(eq(member.id, sam.id));

      await press(buttons[0]?.callback_data as string, messageId);

      const [created] = await tasks();
      expect(
        await test.db
          .select()
          .from(taskAssignee)
          .where(eq(taskAssignee.taskId, created?.id as string)),
      ).toMatchObject([{ memberId: alex.id }]);
    });

    it('creates one task however many times Save is pressed, and leaves the card as it was', async () => {
      const { add, press, tasks, telegram, toasts } = await setup();
      const { messageId, buttons } = await add('Hoover the stairs');
      const save = buttons[0]?.callback_data as string;
      telegram.clear();

      await press(save, messageId);
      await press(save, messageId);
      await Promise.all([press(save, messageId), press(save, messageId)]);

      expect(await tasks()).toHaveLength(1);
      expect(telegram.to('editMessageText')).toHaveLength(1);
      expect(toasts().map((t) => t['text'])).toEqual([
        '✅ Added',
        'That card is out of date. Send /add again.',
        'That card is out of date. Send /add again.',
        'That card is out of date. Send /add again.',
      ]);
    });

    it('drops a draft that is not a valid task instead of saving it, or keeping it to fail again', async () => {
      const { add, press, tasks, drafts, telegram, toasts } = await setup();
      const { messageId, buttons } = await add('Hoover the stairs');
      await test.db
        .update(quickAddDraft)
        .set({ task: { title: '   ', scheduleKind: 'once' } as never });
      telegram.clear();

      await press(buttons[0]?.callback_data as string, messageId);

      expect(await tasks()).toEqual([]);
      expect(await drafts()).toEqual([]);
      expect(telegram.to('editMessageText')[0]).toMatchObject({
        text: '⚠️ I could not add "   ". Send /add to try again.',
        reply_markup: { inline_keyboard: [] },
      });
      expect(toasts()).toMatchObject([{ text: 'I could not add that.' }]);
    });

    it('drops a draft whose schedule the recurrence engine rejects', async () => {
      const { add, press, tasks, drafts, logger, toasts } = await setup();
      const { messageId, buttons } = await add('Hoover the stairs');
      const [draft] = await drafts();
      const rejected = {
        ...draft?.task,
        scheduleKind: 'fixed',
        rrule: 'FREQ=NEVER',
        dueDate: '2027-01-01',
      };
      await test.db.update(quickAddDraft).set({ task: rejected as never });

      await press(buttons[0]?.callback_data as string, messageId);

      // Pressing Save again could not help, so the draft goes rather than failing every time.
      expect(await tasks()).toEqual([]);
      expect(await drafts()).toEqual([]);
      expect(logger.errors).toEqual([]);
      expect(toasts()).toMatchObject([{ text: 'I could not add that.' }]);
    });
  });

  describe('Cancel', () => {
    it('deletes the draft, saves nothing and edits the card without buttons', async () => {
      const { add, press, tasks, drafts, telegram, toasts } = await setup();
      const { messageId, buttons } = await add('Hoover the stairs');
      telegram.clear();

      await press(buttons[1]?.callback_data as string, messageId);

      expect(await tasks()).toEqual([]);
      expect(await drafts()).toEqual([]);
      expect(telegram.to('editMessageText')).toEqual([
        {
          chat_id: CHAT_ID,
          message_id: messageId,
          text: '✖️ Cancelled "Hoover the stairs". Nothing was added.',
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: [] },
        },
      ]);
      expect(toasts()).toMatchObject([{ text: 'Cancelled' }]);

      // Save on the old card now does nothing.
      await press(buttons[0]?.callback_data as string, messageId);
      expect(await tasks()).toEqual([]);
      expect(toasts()[1]).toMatchObject({ text: 'That card is out of date. Send /add again.' });
    });
  });

  describe('who may press', () => {
    it('lets only the author save or cancel, and leaves the draft for them', async () => {
      const { add, press, tasks, drafts, telegram, toasts } = await setup();
      const { messageId, buttons } = await add('Hoover the stairs');
      telegram.clear();

      await press(buttons[0]?.callback_data as string, messageId, { fromId: SAM_TG });
      await press(buttons[1]?.callback_data as string, messageId, { fromId: SAM_TG });

      expect(toasts().map((t) => t['text'])).toEqual([
        'Only the person who sent /add can save or cancel it.',
        'Only the person who sent /add can save or cancel it.',
      ]);
      expect(telegram.to('editMessageText')).toEqual([]);
      expect(await tasks()).toEqual([]);
      expect(await drafts()).toHaveLength(1);

      await press(buttons[0]?.callback_data as string, messageId);
      expect(await tasks()).toHaveLength(1);
    });

    it('asks someone not connected to a member to connect Telegram, and changes nothing', async () => {
      const { add, press, tasks, drafts, telegram, toasts } = await setup();
      const { messageId, buttons } = await add('Hoover the stairs');
      telegram.clear();

      await press(buttons[0]?.callback_data as string, messageId, { fromId: STRANGER });

      expect(toasts()).toMatchObject([
        {
          text: expect.stringContaining('Connect your Telegram first'),
          show_alert: true,
        },
      ]);
      expect(telegram.to('editMessageText')).toEqual([]);
      expect(await tasks()).toEqual([]);
      expect(await drafts()).toHaveLength(1);
    });

    it('ignores a member of another household, even for a draft id they know', async () => {
      const { add, press, tasks, drafts, toasts } = await setup();
      const { messageId, buttons } = await add('Hoover the stairs');
      const elsewhere = await newHousehold(test.db, {
        name: 'Elsewhere',
        telegramGroupChatId: -999,
      });
      await newMember(test.db, elsewhere.id, 'Jo', 3003);

      // In this group: not one of its members. In theirs: not the draft's household.
      await press(buttons[0]?.callback_data as string, messageId, { fromId: 3003 });
      await press(buttons[0]?.callback_data as string, messageId, { fromId: 3003, chatId: -999 });

      expect(toasts()[0]).toMatchObject({ show_alert: true });
      expect(toasts()[1]).toMatchObject({ text: 'That card is out of date. Send /add again.' });
      expect(await tasks()).toEqual([]);
      expect(await drafts()).toHaveLength(1);
    });

    it('stays silent in a group that is not linked', async () => {
      const { add, press, tasks, drafts, toasts } = await setup();
      const { messageId, buttons } = await add('Hoover the stairs');

      await press(buttons[0]?.callback_data as string, messageId, { chatId: -123456 });

      expect(toasts()).toEqual([{ callback_query_id: expect.any(String) }]);
      expect(await tasks()).toEqual([]);
      expect(await drafts()).toHaveLength(1);
    });
  });

  describe('a card that is out of date', () => {
    it('does not save a draft after its day is up, nor leave the card’s buttons doing anything', async () => {
      const { add, press, tasks, drafts, telegram, toasts } = await setup();
      const { messageId, buttons } = await add('Hoover the stairs');
      const [draft] = await drafts();
      const expired = new Date(NOW.getTime() - 24 * 60 * 60 * 1000 - 1000);
      await test.db
        .update(quickAddDraft)
        .set({ createdAt: expired })
        .where(eq(quickAddDraft.id, draft?.id as string));
      telegram.clear();

      await press(buttons[0]?.callback_data as string, messageId);
      await press(buttons[1]?.callback_data as string, messageId);

      expect(toasts().map((t) => t['text'])).toEqual([
        'That card is out of date. Send /add again.',
        'That card is out of date. Send /add again.',
      ]);
      expect(await tasks()).toEqual([]);
    });

    it('still saves a draft just inside its day', async () => {
      const { add, press, tasks, drafts } = await setup();
      const { messageId, buttons } = await add('Hoover the stairs');
      const [draft] = await drafts();
      const nearlyExpired = new Date(NOW.getTime() - 24 * 60 * 60 * 1000 + 1000);
      await test.db
        .update(quickAddDraft)
        .set({ createdAt: nearlyExpired })
        .where(eq(quickAddDraft.id, draft?.id as string));

      await press(buttons[0]?.callback_data as string, messageId);

      expect(await tasks()).toHaveLength(1);
    });

    it('says so for a draft that does not exist, and for data it cannot read', async () => {
      const { press, tasks, toasts } = await setup();

      await press('qs:3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c', 1001);
      await press('qc:3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c', 1001);
      await press('qs:not-a-uuid', 1001);
      await press('qx:3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c', 1001);
      await press('whatever', 1001);

      expect(toasts().map((t) => t['text'])).toEqual([
        'That card is out of date. Send /add again.',
        'That card is out of date. Send /add again.',
        'That button is out of date.',
        'That button is out of date.',
        'That button is out of date.',
      ]);
      expect(await tasks()).toEqual([]);
    });
  });
});
