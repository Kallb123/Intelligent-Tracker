import { MISSED_REMINDER_GRACE_MS, notification, OUTBOX_RETRY_BASE_MS } from '@tracker/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { botDeps } from './bot.js';
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

describe.skipIf(!adminUrl)('delivering reminders to the group (integration)', () => {
  const test = useTestDatabase();

  const reload = async (id: string) => {
    const [n] = await test.db.select().from(notification).where(eq(notification.id, id));
    if (!n) throw new Error('missing');
    return n;
  };

  it('sends everything that is due together as one message, with mentions and buttons', async () => {
    const h = await newHousehold(test.db);
    const alex = await newMember(test.db, h.id, 'Alex', 1001);
    const bins = await newOccurrence(test.db, h.id, 'Put the bins out', { assigneeId: alex.id });
    const plants = await newOccurrence(test.db, h.id, 'Water <plants>');
    const first = await queueGroupReminder(test.db, h.id, bins);
    const second = await queueGroupReminder(test.db, h.id, plants);
    const { bot, telegram } = newTestBot(test.db);

    const result = await deliverGroupMessages(
      test.db,
      bot.api,
      botDeps(test.db, { now: () => NOW }),
    );

    expect(result).toEqual({ delivered: 2, failures: [] });
    expect(telegram.to('sendMessage')).toHaveLength(1);
    const sent = telegram.to('sendMessage')[0];
    expect(sent).toMatchObject({
      chat_id: CHAT_ID,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    expect(sent?.['text']).toBe(
      [
        '1. <a href="tg://user?id=1001">Alex</a>: Put the bins out is due today',
        '2. Anyone 🙋: Water &lt;plants&gt; is due today',
      ].join('\n\n'),
    );
    const keyboard = (sent?.['reply_markup'] as { inline_keyboard: { text: string }[][] })
      .inline_keyboard;
    expect(keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ['✅ 1', '▶️ 1', '⏰ 1', '⏭ 1'],
      ['✅ 2', '▶️ 2', '⏰ 2', '⏭ 2'],
    ]);

    // Both rows are stamped as sent, with the chat and the id Telegram gave the one message.
    const rows = [await reload(first.id), await reload(second.id)];
    expect(rows.map((r) => r.sentAt)).toEqual([NOW, NOW]);
    expect(rows.map((r) => r.telegramChatId)).toEqual([CHAT_ID, CHAT_ID]);
    expect(rows[0]?.telegramMessageId).toBeGreaterThan(0);
    expect(rows[1]?.telegramMessageId).toBe(rows[0]?.telegramMessageId);

    // Nothing is left to send.
    telegram.clear();
    await deliverGroupMessages(test.db, bot.api, botDeps(test.db, { now: () => NOW }));
    expect(telegram.calls).toEqual([]);
  });

  it('mentions nobody for a member who has not linked Telegram', async () => {
    const h = await newHousehold(test.db);
    const sam = await newMember(test.db, h.id, 'Sam');
    const occ = await newOccurrence(test.db, h.id, 'Hoover', { assigneeId: sam.id });
    await queueGroupReminder(test.db, h.id, occ);
    const { bot, telegram } = newTestBot(test.db);

    await deliverGroupMessages(test.db, bot.api, botDeps(test.db, { now: () => NOW }));

    expect(telegram.to('sendMessage')[0]?.['text']).toBe('Sam: Hoover is due today');
  });

  it('sends each household its own message, to its own group', async () => {
    const one = await newHousehold(test.db, { name: 'One', telegramGroupChatId: -1001 });
    const two = await newHousehold(test.db, { name: 'Two', telegramGroupChatId: -1002 });
    await queueGroupReminder(test.db, one.id, await newOccurrence(test.db, one.id, 'Bins'));
    await queueGroupReminder(test.db, two.id, await newOccurrence(test.db, two.id, 'Recycling'));
    const { bot, telegram } = newTestBot(test.db);

    await deliverGroupMessages(test.db, bot.api, botDeps(test.db, { now: () => NOW }));

    const sent = telegram.to('sendMessage');
    expect(sent).toHaveLength(2);
    expect(sent.find((p) => p['chat_id'] === -1001)?.['text']).toContain('Bins');
    expect(sent.find((p) => p['chat_id'] === -1002)?.['text']).toContain('Recycling');
  });

  it('retries after a failed send with backoff, and logs the failure', async () => {
    const h = await newHousehold(test.db);
    const n = await queueGroupReminder(
      test.db,
      h.id,
      await newOccurrence(test.db, h.id, 'Put the bins out'),
    );
    const { bot, telegram, logger } = newTestBot(test.db);
    telegram.failNext('sendMessage', { error_code: 502, description: 'Bad Gateway' });
    let now = NOW;
    const deps = botDeps(test.db, { now: () => now, logger });

    const failed = await deliverGroupMessages(test.db, bot.api, deps);

    expect(failed.delivered).toBe(0);
    expect(failed.failures).toMatchObject([{ notificationId: n.id, attempts: 1, gaveUp: false }]);
    expect(logger.warnings).toEqual(['reminder delivery failed']);
    expect(await reload(n.id)).toMatchObject({
      sentAt: null,
      attempts: 1,
      lastError: expect.stringContaining('Bad Gateway'),
      telegramMessageId: null,
    });

    // Still backing off.
    now = new Date(NOW.getTime() + OUTBOX_RETRY_BASE_MS - 1000);
    await deliverGroupMessages(test.db, bot.api, deps);
    expect(telegram.to('sendMessage')).toHaveLength(1);

    // Backoff over: the retry goes out.
    now = new Date(NOW.getTime() + OUTBOX_RETRY_BASE_MS + 1000);
    const retried = await deliverGroupMessages(test.db, bot.api, deps);
    expect(retried.delivered).toBe(1);
    expect(telegram.to('sendMessage')).toHaveLength(2);
    expect(await reload(n.id)).toMatchObject({ sentAt: now, lastError: null });
  });

  it('gives up on reminders that are too old to post instead of sending them in a burst', async () => {
    const h = await newHousehold(test.db);
    const stale = await queueGroupReminder(
      test.db,
      h.id,
      await newOccurrence(test.db, h.id, 'Old news'),
      { fireAt: new Date(NOW.getTime() - MISSED_REMINDER_GRACE_MS - 1000).toISOString() },
    );
    const fresh = await queueGroupReminder(
      test.db,
      h.id,
      await newOccurrence(test.db, h.id, 'Bins'),
      { fireAt: new Date(NOW.getTime() - MISSED_REMINDER_GRACE_MS + 1000).toISOString() },
    );
    const { bot, telegram, logger } = newTestBot(test.db);

    const result = await deliverGroupMessages(
      test.db,
      bot.api,
      botDeps(test.db, { now: () => NOW, logger }),
    );

    expect(result).toEqual({ delivered: 1, failures: [] });
    expect(telegram.sentTexts).toHaveLength(1);
    expect(telegram.sentTexts[0]).toContain('Bins');
    expect(telegram.sentTexts[0]).not.toContain('Old news');
    expect(await reload(stale.id)).toMatchObject({
      sentAt: null,
      failedAt: NOW,
      lastError: expect.stringContaining('too late'),
    });
    expect((await reload(fresh.id)).sentAt).toEqual(NOW);
    expect(logger.warnings).toEqual(['stale reminders not sent']);
  });

  it('fails the delivery, without calling Telegram, when the group has been unlinked', async () => {
    const h = await newHousehold(test.db, { telegramGroupChatId: null });
    const n = await queueGroupReminder(
      test.db,
      h.id,
      await newOccurrence(test.db, h.id, 'Put the bins out'),
    );
    const { bot, telegram, logger } = newTestBot(test.db);

    const result = await deliverGroupMessages(
      test.db,
      bot.api,
      botDeps(test.db, { now: () => NOW, logger }),
    );

    expect(telegram.calls).toEqual([]);
    expect(result.failures).toMatchObject([
      { notificationId: n.id, error: 'The household has no linked Telegram group' },
    ]);
    expect((await reload(n.id)).sentAt).toBeNull();
  });

  describe("Tonight's jobs", () => {
    // 19:00 in London on 2 Nov (GMT) is the default evening slot.
    const EVENING = '2026-11-02T19:00:00Z';

    async function queueEvening(db = test.db) {
      const h = await newHousehold(db);
      const alex = await newMember(db, h.id, 'Alex', 1001);
      const plain = async (title: string, effortMinutes: number | null, escalated = false) =>
        queueGroupReminder(
          db,
          h.id,
          await newOccurrence(db, h.id, title, { assigneeId: alex.id }),
          {
            fireAt: EVENING,
            effortMinutes,
            ...(escalated ? { kind: 'overdue', overdueDays: 4, escalated: true } : {}),
          },
        );
      await plain('Deep clean the oven', 90);
      await plain('Unknown effort', null);
      await plain('Empty the dishwasher', 10, true);
      await plain('Take out the recycling', 5);
      return h;
    }

    it('sends the evening reminders under a heading, quickest first, with the escalated one loud', async () => {
      await queueEvening();
      const { bot, telegram } = newTestBot(test.db);

      await deliverGroupMessages(test.db, bot.api, botDeps(test.db, { now: () => NOW }));

      expect(telegram.sentTexts).toMatchInlineSnapshot(`
        [
          "🌙 <b>Tonight's jobs</b>

        1. <a href="tg://user?id=1001">Alex</a>: Take out the recycling is due today

        2. 🚨 <b><a href="tg://user?id=1001">Alex</a>: Still not done after 4 days: Empty the dishwasher</b>

        3. <a href="tg://user?id=1001">Alex</a>: Deep clean the oven is due today

        4. <a href="tg://user?id=1001">Alex</a>: Unknown effort is due today",
        ]
      `);
    });

    it('keeps the heading and the order when the message is redrawn after a button press', async () => {
      await queueEvening();
      const { bot, telegram } = newTestBot(test.db);
      await deliverGroupMessages(test.db, bot.api, botDeps(test.db, { now: () => NOW }));
      const keyboard = (
        telegram.to('sendMessage')[0]?.['reply_markup'] as {
          inline_keyboard: { callback_data: string }[][];
        }
      ).inline_keyboard;

      // Done on line 1, the quickest job.
      await bot.handleUpdate(
        pressUpdate({
          chatId: CHAT_ID,
          messageId: 1001,
          fromId: 1001,
          data: keyboard[0]?.[0]?.callback_data as string,
        }),
      );

      expect(telegram.to('editMessageText')[0]?.['text']).toMatchInlineSnapshot(`
        "🌙 <b>Tonight's jobs</b>

        1. <s>Alex: Take out the recycling is due today</s>
        ✅ Done by Alex

        2. 🚨 <b><a href="tg://user?id=1001">Alex</a>: Still not done after 4 days: Empty the dishwasher</b>

        3. <a href="tg://user?id=1001">Alex</a>: Deep clean the oven is due today

        4. <a href="tg://user?id=1001">Alex</a>: Unknown effort is due today"
      `);
    });

    it('sends no heading for reminders at any other time', async () => {
      const h = await newHousehold(test.db);
      await queueGroupReminder(test.db, h.id, await newOccurrence(test.db, h.id, 'Bins'), {
        fireAt: '2026-11-02T08:00:00Z',
      });
      const { bot, telegram } = newTestBot(test.db);

      await deliverGroupMessages(test.db, bot.api, botDeps(test.db, { now: () => NOW }));

      expect(telegram.sentTexts).toEqual(['Anyone 🙋: Bins is due today']);
    });
  });
});
