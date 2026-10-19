import { listSuggestions, occurrence, resolveSuggestion, task } from '@tracker/db';
import { seedSuggestionHistory } from '@tracker/db/test-db';
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

describe.skipIf(!adminUrl)('Telegram suggestion cards (integration)', () => {
  const test = useTestDatabase();
  async function setup() {
    const h = await newHousehold(test.db);
    const alex = await newMember(test.db, h.id, 'Alex', 1001);
    const [series] = await test.db
      .insert(task)
      .values({
        householdId: h.id,
        title: 'Renew <insurance>',
        scheduleKind: 'fixed',
        rrule: 'FREQ=YEARLY',
        dueDate: '2026-12-01',
        leadTimeDays: 7,
      })
      .returning();
    await seedSuggestionHistory(test.db, {
      householdId: h.id,
      memberId: alex.id,
      taskId: series!.id,
      dates: ['2026-10-01', '2026-10-10', '2026-10-20'],
    });
    const harness = newTestBot(test.db);
    const command = (
      fromId = 1001,
      chatId = CHAT_ID,
      chatType: 'supergroup' | 'private' = 'supergroup',
    ) =>
      harness.bot.handleUpdate(commandUpdate({ chatId, chatType, fromId, text: '/suggestions' }));
    const press = (data: string, fromId = 1001, chatId = CHAT_ID) =>
      harness.bot.handleUpdate(
        pressUpdate({
          chatId,
          messageId: 1001,
          fromId,
          data,
        }),
      );
    return { ...harness, h, alex, series: series!, command, press };
  }

  it('shows bounded plain-text cards with buttons and accepts once', async () => {
    const { h, series, command, press, telegram } = await setup();
    await command();
    expect(telegram.sentTexts[0]).toContain('Renew <insurance>');
    const card = telegram.to('sendMessage')[0]!;
    expect(card).not.toHaveProperty('parse_mode');
    expect(card).toHaveProperty('link_preview_options', { is_disabled: true });
    const markup = card['reply_markup'] as { inline_keyboard: { callback_data: string }[][] };
    const data = markup.inline_keyboard[0]![0]!.callback_data;
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect((await test.db.select().from(task).where(eq(task.id, series.id)))[0]?.leadTimeDays).toBe(
      7,
    );
    await press(data);
    await press(data);
    expect((await test.db.select().from(task).where(eq(task.id, series.id)))[0]?.leadTimeDays).toBe(
      14,
    );
    expect(await listSuggestions(test.db, h.id, NOW)).toEqual([]);
    expect(telegram.to('editMessageText')).toMatchObject([
      { text: '✅ Suggestion accepted. Task updated.', reply_markup: { inline_keyboard: [] } },
    ]);
    expect(telegram.to('answerCallbackQuery').at(-1)?.['text']).toContain('out of date');
    expect(
      await test.db.select().from(occurrence).where(eq(occurrence.taskId, series.id)),
    ).toHaveLength(4);
  });

  it('dismisses across channels without changing the task', async () => {
    const { h, series, command, press, telegram } = await setup();
    const [card] = await listSuggestions(test.db, h.id, NOW);
    await command();
    await press(`sd:${card!.id}`);
    expect(await listSuggestions(test.db, h.id, NOW)).toEqual([]);
    expect((await test.db.select().from(task).where(eq(task.id, series.id)))[0]?.leadTimeDays).toBe(
      7,
    );
    expect(telegram.to('editMessageText')[0]?.['text']).toContain('dismissed');
  });

  it('refuses unlinked users, foreign members/groups, stale cards, and malformed callbacks', async () => {
    const { h, alex, command, press, telegram } = await setup();
    const foreign = await newHousehold(test.db, { telegramGroupChatId: -999 });
    await newMember(test.db, foreign.id, 'Other', 2002);
    const [card] = await listSuggestions(test.db, h.id, NOW);
    await command(4242);
    expect(telegram.sentTexts[0]).toContain('Connect your Telegram first');
    await press(`sa:${card!.id}`, 4242);
    await press(`sa:${card!.id}`, 2002);
    expect(telegram.to('answerCallbackQuery').every((t) => t['show_alert'] === true)).toBe(true);
    await press(`sa:${card!.id}`, 1001, -12345);
    expect(telegram.to('answerCallbackQuery').at(-1)?.['text']).toBeUndefined();
    await resolveSuggestion(test.db, {
      householdId: h.id,
      memberId: alex.id,
      id: card!.id,
      action: 'dismiss',
      now: NOW,
    });
    await press(`sa:${card!.id}`);
    expect(telegram.to('answerCallbackQuery').at(-1)?.['text']).toContain('out of date');
    await press('sa:invalid');
    expect(telegram.to('answerCallbackQuery').at(-1)?.['text']).toContain('out of date');
  });

  it('keeps private and unrelated groups out of the inbox and reports an empty inbox', async () => {
    const { h, alex, command, telegram } = await setup();
    await command(1001, 1001, 'private');
    expect(telegram.sentTexts[0]).toContain('house group');
    telegram.clear();
    await command(1001, -12345);
    expect(telegram.sentTexts).toEqual([]);
    const [card] = await listSuggestions(test.db, h.id, NOW);
    await resolveSuggestion(test.db, {
      householdId: h.id,
      memberId: alex.id,
      id: card!.id,
      action: 'dismiss',
      now: NOW,
    });
    await command();
    expect(telegram.sentTexts[0]).toContain('No suggestions right now');
  });
});
