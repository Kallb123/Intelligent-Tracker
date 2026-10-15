import { applyOccurrenceAction, occurrence } from '@tracker/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { botDeps } from './bot.js';
import { encodeCallback, type CallbackAction } from './callback-data.js';
import { deliverGroupMessages } from './delivery.js';
import {
  adminUrl,
  CHAT_ID,
  newHousehold,
  newMember,
  newOccurrence,
  newTestBot,
  NOW,
  pressUpdate,
  queueGroupReminder,
  useTestDatabase,
} from './test-harness.js';

const ALEX_TG = 1001;
const SAM_TG = 2002;

describe.skipIf(!adminUrl)('button presses in the group (integration)', () => {
  const test = useTestDatabase();

  /**
   * A household with a linked group and two linked members, and one reminder for each of
   * `titles` already delivered as one message (so presses find the message's lines again).
   */
  async function deliveredMessage(titles: string[] = ['Put the bins out']) {
    const h = await newHousehold(test.db);
    const alex = await newMember(test.db, h.id, 'Alex', ALEX_TG);
    const sam = await newMember(test.db, h.id, 'Sam', SAM_TG);
    const occurrences = [];
    for (const title of titles) {
      const occ = await newOccurrence(test.db, h.id, title, { assigneeId: alex.id });
      await queueGroupReminder(test.db, h.id, occ);
      occurrences.push(occ.occurrence);
    }
    const harness = newTestBot(test.db);
    await deliverGroupMessages(
      test.db,
      harness.bot.api,
      botDeps(test.db, { now: () => NOW, logger: harness.logger }),
    );
    const sent = harness.telegram.to('sendMessage');
    expect(sent).toHaveLength(1);
    // The fake numbers messages from 1001; the first (and only) one.
    const messageId = 1001;
    harness.telegram.clear();

    const press = (action: CallbackAction, fromId = SAM_TG, chatId = CHAT_ID, id = messageId) =>
      harness.bot.handleUpdate(
        pressUpdate({ chatId, messageId: id, fromId, data: encodeCallback(action) }),
      );
    const stored = async (id: string) => {
      const [o] = await test.db.select().from(occurrence).where(eq(occurrence.id, id));
      if (!o) throw new Error('missing');
      return o;
    };
    return { h, alex, sam, occurrences, messageId, press, stored, ...harness };
  }

  const edited = (telegram: { to(method: string): Record<string, unknown>[] }) =>
    telegram.to('editMessageText');
  const labels = (edit: Record<string, unknown> | undefined) =>
    (edit?.['reply_markup'] as { inline_keyboard: { text: string }[][] }).inline_keyboard.map(
      (row) => row.map((b) => b.text),
    );

  it('completes the occurrence as the member who pressed, and edits the message in place', async () => {
    const { occurrences, sam, press, stored, telegram, messageId } = await deliveredMessage();
    const [occ] = occurrences;
    if (!occ) throw new Error('no occurrence');

    await press({ type: 'complete', occurrenceId: occ.id });

    expect(await stored(occ.id)).toMatchObject({ status: 'done', completedBy: sam.id });
    // Edited in place: no new message.
    expect(telegram.to('sendMessage')).toEqual([]);
    expect(edited(telegram)).toHaveLength(1);
    const edit = edited(telegram)[0];
    expect(edit).toMatchObject({
      chat_id: CHAT_ID,
      message_id: messageId,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    expect(edit?.['text']).toBe('<s>Alex: Put the bins out is due today</s>\n✅ Done by Sam');
    expect(labels(edit)).toEqual([]);
    expect(telegram.to('answerCallbackQuery')).toEqual([
      { callback_query_id: expect.any(String), text: '✅ Done' },
    ]);
  });

  it('records a start, keeps the other buttons and says who started it', async () => {
    const { occurrences, press, stored, telegram } = await deliveredMessage();
    const [occ] = occurrences;
    if (!occ) throw new Error('no occurrence');

    await press({ type: 'start', occurrenceId: occ.id });

    expect((await stored(occ.id)).status).toBe('started');
    const edit = edited(telegram)[0];
    expect(edit?.['text']).toBe(
      '<a href="tg://user?id=1001">Alex</a>: Put the bins out is due today\n▶️ Started by Sam',
    );
    expect(labels(edit)).toEqual([['✅ Done', '⏰ Snooze', '⏭ Skip']]);
    expect(telegram.to('answerCallbackQuery')[0]).toMatchObject({ text: '▶️ Started' });
  });

  it('skips the occurrence', async () => {
    const { occurrences, press, stored, telegram } = await deliveredMessage();
    const [occ] = occurrences;
    if (!occ) throw new Error('no occurrence');

    await press({ type: 'skip', occurrenceId: occ.id });

    expect((await stored(occ.id)).status).toBe('skipped');
    expect(edited(telegram)[0]?.['text']).toBe(
      '<s>Alex: Put the bins out is due today</s>\n⏭ Skipped by Sam',
    );
    expect(telegram.to('answerCallbackQuery')[0]).toMatchObject({ text: '⏭ Skipped' });
  });

  it('only redraws the line that was pressed when the message has several', async () => {
    const { occurrences, press, stored, telegram } = await deliveredMessage(['Bins', 'Plants']);
    const [, second] = occurrences;
    if (!second) throw new Error('no occurrence');

    await press({ type: 'complete', occurrenceId: second.id });

    expect((await stored(second.id)).status).toBe('done');
    const edit = edited(telegram)[0];
    expect(edit?.['text']).toBe(
      [
        '1. <a href="tg://user?id=1001">Alex</a>: Bins is due today',
        '2. <s>Alex: Plants is due today</s>\n✅ Done by Sam',
      ].join('\n\n'),
    );
    expect(labels(edit)).toEqual([['✅ 1', '▶️ 1', '⏰ 1', '⏭ 1']]);
  });

  describe('a Telegram user who is not linked to a member', () => {
    it('gets a pop-up asking them to link first, and nothing changes', async () => {
      const { occurrences, press, stored, telegram } = await deliveredMessage();
      const [occ] = occurrences;
      if (!occ) throw new Error('no occurrence');

      await press({ type: 'complete', occurrenceId: occ.id }, 9999);

      expect((await stored(occ.id)).status).toBe('active');
      expect(telegram.to('answerCallbackQuery')).toEqual([
        {
          callback_query_id: expect.any(String),
          text: expect.stringContaining('Connect Telegram'),
          show_alert: true,
        },
      ]);
      expect(edited(telegram)).toEqual([]);
    });

    it('is also a member of another household', async () => {
      const { occurrences, press, stored, telegram } = await deliveredMessage();
      const [occ] = occurrences;
      if (!occ) throw new Error('no occurrence');
      const other = await newHousehold(test.db, { name: 'Other', telegramGroupChatId: -5 });
      await newMember(test.db, other.id, 'Stranger', 3003);

      await press({ type: 'complete', occurrenceId: occ.id }, 3003);

      expect((await stored(occ.id)).status).toBe('active');
      expect(telegram.to('answerCallbackQuery')[0]).toMatchObject({ show_alert: true });
    });
  });

  describe('snoozing', () => {
    it('opens the choices on the occurrence row, and Back closes them', async () => {
      const { occurrences, press, stored, telegram } = await deliveredMessage();
      const [occ] = occurrences;
      if (!occ) throw new Error('no occurrence');

      await press({ type: 'snoozeMenu', occurrenceId: occ.id });

      expect(labels(edited(telegram)[0])).toEqual([
        ['Tonight', 'Tomorrow', 'Weekend', '3 days'],
        ['↩ Back'],
      ]);
      expect((await stored(occ.id)).snoozedUntil).toBeNull();
      expect(telegram.to('answerCallbackQuery')[0]).not.toHaveProperty('text');

      telegram.clear();
      await press({ type: 'back', occurrenceId: occ.id });

      expect(labels(edited(telegram)[0])).toEqual([
        ['✅ Done', '▶️ Started', '⏰ Snooze', '⏭ Skip'],
      ]);
    });

    it('snoozes until the evening slot and says who and until when', async () => {
      const { occurrences, press, stored, telegram } = await deliveredMessage();
      const [occ] = occurrences;
      if (!occ) throw new Error('no occurrence');

      await press({ type: 'snooze', key: 'tomorrow', occurrenceId: occ.id });

      // Tomorrow's 19:00 slot, London time (GMT in November).
      expect((await stored(occ.id)).snoozedUntil).toEqual(new Date('2026-11-03T19:00:00Z'));
      expect(edited(telegram)[0]?.['text']).toBe(
        '<a href="tg://user?id=1001">Alex</a>: Put the bins out is due today\n⏰ Snoozed until Tue 19:00 by Sam',
      );
      expect(labels(edited(telegram)[0])).toEqual([
        ['✅ Done', '▶️ Started', '⏰ Snooze', '⏭ Skip'],
      ]);
      expect(telegram.to('answerCallbackQuery')[0]).toMatchObject({
        text: '⏰ Snoozed until Tue 19:00',
      });
    });

    it('refuses a choice whose time has already passed', async () => {
      const { occurrences, stored } = await deliveredMessage();
      const [occ] = occurrences;
      if (!occ) throw new Error('no occurrence');
      // After the evening slot, "tonight" is gone: the menu was opened earlier.
      const late = newTestBot(test.db, { now: () => new Date('2026-11-02T20:00:00Z') });
      await late.bot.handleUpdate(
        pressUpdate({
          chatId: CHAT_ID,
          messageId: 1001,
          fromId: SAM_TG,
          data: encodeCallback({ type: 'snooze', key: 'tonight', occurrenceId: occ.id }),
        }),
      );

      expect((await stored(occ.id)).snoozedUntil).toBeNull();
      expect(late.telegram.to('answerCallbackQuery')[0]).toMatchObject({
        text: 'That time has already passed.',
      });
    });
  });

  describe('an occurrence that was closed in the meantime', () => {
    it('tells the presser, and redraws the message with who closed it', async () => {
      const { occurrences, alex, press, stored, telegram, h } = await deliveredMessage();
      const [occ] = occurrences;
      if (!occ) throw new Error('no occurrence');
      await applyOccurrenceAction(test.db, {
        householdId: h.id,
        memberId: alex.id,
        occurrenceId: occ.id,
        now: NOW,
        action: { type: 'complete' },
      });

      await press({ type: 'skip', occurrenceId: occ.id });

      expect((await stored(occ.id)).status).toBe('done');
      expect(telegram.to('answerCallbackQuery')[0]).toMatchObject({
        text: 'That job is already done.',
      });
      expect(edited(telegram)[0]?.['text']).toBe(
        '<s>Alex: Put the bins out is due today</s>\n✅ Done by Alex',
      );
      expect(labels(edited(telegram)[0])).toEqual([]);
    });

    it('says the job no longer exists when the occurrence was deleted', async () => {
      const { occurrences, press, telegram } = await deliveredMessage();
      const [occ] = occurrences;
      if (!occ) throw new Error('no occurrence');
      await test.db.delete(occurrence).where(eq(occurrence.id, occ.id));

      await press({ type: 'complete', occurrenceId: occ.id });

      expect(telegram.to('answerCallbackQuery')[0]).toMatchObject({
        text: 'That job no longer exists.',
      });
      expect(edited(telegram)[0]?.['text']).toBe(
        '<s>Alex: Put the bins out is due today</s>\n🗑 Removed',
      );
    });
  });

  describe('edits that Telegram refuses', () => {
    it('ignores "message is not modified"', async () => {
      const { occurrences, press, telegram, logger } = await deliveredMessage();
      const [occ] = occurrences;
      if (!occ) throw new Error('no occurrence');
      telegram.failNext('editMessageText', {
        error_code: 400,
        description: 'Bad Request: message is not modified',
      });

      await press({ type: 'back', occurrenceId: occ.id });

      expect(logger.errors).toEqual([]);
      expect(telegram.to('answerCallbackQuery')).toHaveLength(1);
    });

    it('logs any other failure and still answers the press', async () => {
      const { occurrences, press, stored, telegram, logger } = await deliveredMessage();
      const [occ] = occurrences;
      if (!occ) throw new Error('no occurrence');
      telegram.failNext('editMessageText', {
        error_code: 400,
        description: 'Bad Request: message to edit not found',
      });

      await press({ type: 'complete', occurrenceId: occ.id });

      expect((await stored(occ.id)).status).toBe('done');
      expect(logger.errors).toEqual(['editing the message failed']);
      expect(telegram.to('answerCallbackQuery')[0]).toMatchObject({ text: '✅ Done' });
    });
  });

  describe('presses that are not for the bot to act on', () => {
    it('ignores a press in a chat that is not the household group', async () => {
      const { occurrences, press, stored, telegram } = await deliveredMessage();
      const [occ] = occurrences;
      if (!occ) throw new Error('no occurrence');

      await press({ type: 'complete', occurrenceId: occ.id }, SAM_TG, -999);

      expect((await stored(occ.id)).status).toBe('active');
      expect(telegram.calls.map((c) => c.method)).toEqual(['answerCallbackQuery']);
    });

    it('says it has no details for a message it did not send', async () => {
      const { occurrences, press, stored, telegram } = await deliveredMessage();
      const [occ] = occurrences;
      if (!occ) throw new Error('no occurrence');

      await press({ type: 'complete', occurrenceId: occ.id }, SAM_TG, CHAT_ID, 4242);

      expect((await stored(occ.id)).status).toBe('active');
      expect(telegram.to('answerCallbackQuery')[0]).toMatchObject({
        text: 'I no longer have the details of that message.',
      });
      expect(edited(telegram)).toEqual([]);
    });

    it('says a button with data it does not know is out of date', async () => {
      const { bot, telegram } = await deliveredMessage();

      await bot.handleUpdate(
        pressUpdate({ chatId: CHAT_ID, messageId: 1001, fromId: SAM_TG, data: 'nonsense' }),
      );

      expect(telegram.to('answerCallbackQuery')[0]).toMatchObject({
        text: 'That button is out of date.',
      });
    });

    it('answers with an error and logs when the database fails', async () => {
      const { occurrences } = await deliveredMessage();
      const [occ] = occurrences;
      if (!occ) throw new Error('no occurrence');
      const broken = new Proxy(test.db, {
        get: (target, prop, receiver) =>
          prop === 'select'
            ? () => {
                throw new Error('connection lost');
              }
            : Reflect.get(target, prop, receiver),
      });
      const { bot, telegram, logger } = newTestBot(broken);

      await bot.handleUpdate(
        pressUpdate({
          chatId: CHAT_ID,
          messageId: 1001,
          fromId: SAM_TG,
          data: encodeCallback({ type: 'complete', occurrenceId: occ.id }),
        }),
      );

      expect(logger.errors).toEqual(['button press failed']);
      expect(telegram.to('answerCallbackQuery')).toEqual([
        { callback_query_id: expect.any(String), text: 'Something went wrong. Try again.' },
      ]);
    });
  });
});
