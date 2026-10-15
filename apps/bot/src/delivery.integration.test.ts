import { notification, OUTBOX_RETRY_BASE_MS } from '@tracker/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { botDeps } from './bot.js';
import { deliverGroupMessages, startDeliveryLoop } from './delivery.js';
import {
  adminUrl,
  CHAT_ID,
  newHousehold,
  newMember,
  newOccurrence,
  newTestBot,
  NOW,
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

    // Both rows are stamped as sent, with the id Telegram gave the one message.
    const rows = [await reload(first.id), await reload(second.id)];
    expect(rows.map((r) => r.sentAt)).toEqual([NOW, NOW]);
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

  describe('the loop', () => {
    it('delivers straight away and again on every interval until stopped', async () => {
      const h = await newHousehold(test.db);
      await queueGroupReminder(test.db, h.id, await newOccurrence(test.db, h.id, 'Bins'));
      const { bot, telegram } = newTestBot(test.db);
      const loop = startDeliveryLoop(test.db, bot.api, botDeps(test.db, { now: () => NOW }), 20);

      await vi.waitFor(() => expect(telegram.to('sendMessage')).toHaveLength(1));
      // Queued while the loop is already running: picked up by a later run.
      await queueGroupReminder(test.db, h.id, await newOccurrence(test.db, h.id, 'Recycling'));
      await vi.waitFor(() => expect(telegram.to('sendMessage')).toHaveLength(2));
      await loop.stop();

      const calls = telegram.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(telegram.calls).toHaveLength(calls);
    });

    it('logs a run that fails and keeps going', async () => {
      const { bot, logger } = newTestBot(test.db);
      const deps = botDeps(test.db, { now: () => NOW, logger });
      // A database error (as opposed to a failed send) escapes `deliverOutboxBatches`.
      const broken = new Proxy(test.db, {
        get: (target, prop, receiver) =>
          prop === 'transaction'
            ? () => Promise.reject(new Error('connection lost'))
            : Reflect.get(target, prop, receiver),
      });
      const loop = startDeliveryLoop(broken, bot.api, { ...deps, db: broken }, 10);

      await vi.waitFor(() => expect(logger.errors.length).toBeGreaterThanOrEqual(2));
      await loop.stop();
      expect(logger.errors[0]).toBe('delivery run failed');
    });
  });
});
