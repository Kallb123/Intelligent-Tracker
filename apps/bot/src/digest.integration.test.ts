import { bankHoliday, occurrence, task } from '@tracker/db';
import { describe, expect, it } from 'vitest';
import {
  adminUrl,
  CHAT_ID,
  commandUpdate,
  newHousehold,
  newTestBot,
  NOW,
  useTestDatabase,
} from './test-harness.js';

describe.skipIf(!adminUrl)('/digest (integration)', () => {
  const test = useTestDatabase();
  const command = (chatId: number, chatType: 'private' | 'supergroup' = 'supergroup') =>
    commandUpdate({ chatId, chatType, fromId: 1, text: '/digest' });
  it('shows the linked household’s active jobs and regional holidays, ignores other chats', async () => {
    const h = await newHousehold(test.db);
    const other = await newHousehold(test.db, { name: 'Elsewhere', telegramGroupChatId: -999 });
    const t = (
      await test.db
        .insert(task)
        .values({ householdId: h.id, title: 'Check the bins', scheduleKind: 'once' })
        .returning()
    )[0]!;
    const hidden = (
      await test.db
        .insert(task)
        .values({ householdId: other.id, title: 'Private chore', scheduleKind: 'once' })
        .returning()
    )[0]!;
    await test.db.insert(occurrence).values([
      { taskId: t.id, status: 'active' },
      { taskId: hidden.id, status: 'active' },
    ]);
    const today = NOW.toISOString().slice(0, 10);
    await test.db
      .insert(bankHoliday)
      .values([
        { region: 'england-and-wales', date: today, title: 'Test bank holiday' },
        { region: 'scotland', date: today, title: 'Scottish holiday' },
      ])
      .onConflictDoNothing();
    const { bot, telegram } = newTestBot(test.db);
    await bot.handleUpdate(command(CHAT_ID));
    expect(telegram.sentTexts).toHaveLength(1);
    expect(telegram.sentTexts[0]).toContain('Check the bins');
    expect(telegram.sentTexts[0]).toContain('Test bank holiday');
    expect(telegram.sentTexts[0]).not.toContain('Private chore');
    expect(telegram.sentTexts[0]).not.toContain('Scottish holiday');
    await bot.handleUpdate(command(-123456));
    await bot.handleUpdate(command(1, 'private'));
    expect(telegram.sentTexts).toHaveLength(1);
  });
});
