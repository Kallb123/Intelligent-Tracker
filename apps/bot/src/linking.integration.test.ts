import {
  household,
  issueGroupLinkCode,
  issueMemberLinkCode,
  TELEGRAM_LINK_CODE_TTL_MS,
  member,
  unlinkMember,
} from '@tracker/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  adminUrl,
  CHAT_ID,
  commandUpdate,
  migrateUpdate,
  newHousehold,
  newMember,
  newTestBot,
  NOW,
  pressUpdate,
  useTestDatabase,
} from './test-harness.js';

describe.skipIf(!adminUrl)('bot linking (integration)', () => {
  const test = useTestDatabase();

  const groupCommand = (
    text: string,
    chatId = CHAT_ID,
    chatType: 'group' | 'supergroup' = 'supergroup',
  ) => commandUpdate({ chatId, chatType, fromId: 1, text });
  const privateCommand = (text: string, fromId = 5001) =>
    commandUpdate({ chatId: fromId, chatType: 'private', fromId, text });

  const reload = async (id: string) => {
    const [h] = await test.db.select().from(household).where(eq(household.id, id));
    if (!h) throw new Error('missing');
    return h;
  };

  describe('/linkgroup', () => {
    it('links the group with a valid code and confirms', async () => {
      const h = await newHousehold(test.db, { telegramGroupChatId: null });
      const { code } = await issueGroupLinkCode(test.db, h.id, { now: NOW });
      const { bot, telegram } = newTestBot(test.db);

      await bot.handleUpdate(groupCommand(`/linkgroup ${code}`));

      expect((await reload(h.id)).telegramGroupChatId).toBe(CHAT_ID);
      expect(telegram.to('sendMessage')).toHaveLength(1);
      expect(telegram.to('sendMessage')[0]).toMatchObject({ chat_id: CHAT_ID });
      expect(telegram.sentTexts[0]).toContain('now linked to The Smiths');
    });

    it('accepts the command addressed to the bot, in a plain group', async () => {
      const h = await newHousehold(test.db, { telegramGroupChatId: null });
      const { code } = await issueGroupLinkCode(test.db, h.id, { now: NOW });
      const { bot } = newTestBot(test.db);

      await bot.handleUpdate(groupCommand(`/linkgroup@tracker_bot ${code}`, -4242, 'group'));

      expect((await reload(h.id)).telegramGroupChatId).toBe(-4242);
    });

    it('refuses a wrong code and leaves the household unlinked', async () => {
      const h = await newHousehold(test.db, { telegramGroupChatId: null });
      await issueGroupLinkCode(test.db, h.id, { now: NOW });
      const { bot, telegram } = newTestBot(test.db);

      await bot.handleUpdate(groupCommand('/linkgroup not-the-code'));

      expect((await reload(h.id)).telegramGroupChatId).toBeNull();
      expect(telegram.sentTexts).toHaveLength(1);
      expect(telegram.sentTexts[0]).toContain('not valid');
    });

    it('refuses an expired code', async () => {
      const h = await newHousehold(test.db, { telegramGroupChatId: null });
      const { code } = await issueGroupLinkCode(test.db, h.id, {
        now: new Date(NOW.getTime() - TELEGRAM_LINK_CODE_TTL_MS - 1000),
      });
      const { bot, telegram } = newTestBot(test.db);

      await bot.handleUpdate(groupCommand(`/linkgroup ${code}`));

      expect((await reload(h.id)).telegramGroupChatId).toBeNull();
      expect(telegram.sentTexts[0]).toContain('expired');
    });

    it('refuses a group that belongs to another household and spends the code', async () => {
      const owner = await newHousehold(test.db, { name: 'Owners', telegramGroupChatId: CHAT_ID });
      const h = await newHousehold(test.db, { name: 'Others', telegramGroupChatId: null });
      const { code } = await issueGroupLinkCode(test.db, h.id, { now: NOW });
      const { bot, telegram } = newTestBot(test.db);

      await bot.handleUpdate(groupCommand(`/linkgroup ${code}`));

      expect((await reload(owner.id)).telegramGroupChatId).toBe(CHAT_ID);
      expect(await reload(h.id)).toMatchObject({
        telegramGroupChatId: null,
        telegramGroupLinkCode: null,
        telegramGroupLinkExpiresAt: null,
      });
      expect(telegram.sentTexts[0]).toContain('already belongs to another household');
      expect(telegram.sentTexts[0]).toContain('used up');

      // The code was posted in the group, so it is dead even once the group is free.
      await test.db
        .update(household)
        .set({ telegramGroupChatId: null })
        .where(eq(household.id, owner.id));
      await bot.handleUpdate(groupCommand(`/linkgroup ${code}`));
      expect((await reload(h.id)).telegramGroupChatId).toBeNull();
    });

    it('explains the usage when there is no code', async () => {
      const { bot, telegram } = newTestBot(test.db);

      await bot.handleUpdate(groupCommand('/linkgroup'));

      expect(telegram.sentTexts[0]).toContain('Send /linkgroup <code>');
    });

    it('tells people to send it in the house group when used in a private chat', async () => {
      const h = await newHousehold(test.db, { telegramGroupChatId: null });
      const { code } = await issueGroupLinkCode(test.db, h.id, { now: NOW });
      const { bot, telegram } = newTestBot(test.db);

      await bot.handleUpdate(privateCommand(`/linkgroup ${code}`));

      expect(telegram.sentTexts[0]).toContain('in the house group');
      // The code was not spent on the private chat.
      expect((await reload(h.id)).telegramGroupChatId).toBeNull();
      await bot.handleUpdate(groupCommand(`/linkgroup ${code}`));
      expect((await reload(h.id)).telegramGroupChatId).toBe(CHAT_ID);
    });
  });

  describe('/start', () => {
    it('links the Telegram user to the member and greets them by name', async () => {
      const h = await newHousehold(test.db);
      const alex = await newMember(test.db, h.id, 'Alex');
      const { code } = await issueMemberLinkCode(test.db, alex.id, { now: NOW });
      const { bot, telegram } = newTestBot(test.db);

      await bot.handleUpdate(privateCommand(`/start ${code}`));

      const [linked] = await test.db.select().from(member).where(eq(member.id, alex.id));
      expect(linked?.telegramUserId).toBe(5001);
      expect(telegram.to('sendMessage')[0]).toMatchObject({ chat_id: 5001 });
      expect(telegram.sentTexts[0]).toContain("You're linked as Alex");
    });

    it('refuses a Telegram account that is already connected to another member', async () => {
      const h = await newHousehold(test.db);
      const alex = await newMember(test.db, h.id, 'Alex', 5001);
      const sam = await newMember(test.db, h.id, 'Sam');
      const { code } = await issueMemberLinkCode(test.db, sam.id, { now: NOW });
      const { bot, telegram } = newTestBot(test.db, { publicBaseUrl: 'https://tracker.example' });

      await bot.handleUpdate(privateCommand(`/start ${code}`));

      const text = telegram.sentTexts[0] ?? '';
      expect(text).toContain('already connected to Alex');
      expect(text).toContain('disconnect');
      expect(text).toContain('Account → Telegram');
      expect(text).not.toContain("You're linked");
      const members = await test.db.select().from(member);
      expect(Object.fromEntries(members.map((m) => [m.name, m.telegramUserId]))).toEqual({
        Alex: 5001,
        Sam: null,
      });
      // The code is still good once Alex has disconnected.
      await unlinkMember(test.db, alex.id);
      await bot.handleUpdate(privateCommand(`/start ${code}`));
      expect(telegram.sentTexts[1]).toContain("You're linked as Sam");
    });

    it('explains how to connect from the web app without a code', async () => {
      const { bot, telegram } = newTestBot(test.db, { publicBaseUrl: 'https://tracker.example' });

      await bot.handleUpdate(privateCommand('/start'));

      expect(telegram.sentTexts[0]).toContain('https://tracker.example');
      expect(telegram.sentTexts[0]).toContain('Account → Telegram');
      expect(telegram.sentTexts[0]).not.toContain('not valid');
    });

    it('explains the same after a code that is not valid, and links nobody', async () => {
      const h = await newHousehold(test.db);
      const alex = await newMember(test.db, h.id, 'Alex');
      const { bot, telegram } = newTestBot(test.db);

      await bot.handleUpdate(privateCommand('/start wrong'));

      expect(telegram.sentTexts[0]).toContain('not valid or has expired');
      expect(telegram.sentTexts[0]).toContain('Account → Telegram');
      const [after] = await test.db.select().from(member).where(eq(member.id, alex.id));
      expect(after?.telegramUserId).toBeNull();
    });

    it('does not answer /start in the group', async () => {
      await newHousehold(test.db);
      const { bot, telegram } = newTestBot(test.db);

      await bot.handleUpdate(groupCommand('/start'));

      expect(telegram.calls).toEqual([]);
    });
  });

  describe('groups that are not linked', () => {
    it('ignores commands and button presses there', async () => {
      await newHousehold(test.db, { telegramGroupChatId: CHAT_ID });
      const { bot, telegram } = newTestBot(test.db);

      await bot.handleUpdate(groupCommand('/today', -777));
      await bot.handleUpdate(groupCommand('/start', -777));
      await bot.handleUpdate(
        pressUpdate({
          chatId: -777,
          messageId: 5,
          fromId: 1,
          data: 'd:3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c',
        }),
      );

      // Only the press is answered (an empty answer, which stops the button's spinner).
      expect(telegram.calls.map((c) => c.method)).toEqual(['answerCallbackQuery']);
      expect(telegram.calls[0]?.payload).not.toHaveProperty('text');
    });
  });

  describe('group migration', () => {
    it('follows a group that becomes a supergroup', async () => {
      const h = await newHousehold(test.db, { telegramGroupChatId: -4242 });
      const { bot, telegram } = newTestBot(test.db);

      await bot.handleUpdate(migrateUpdate(-4242, CHAT_ID));

      expect((await reload(h.id)).telegramGroupChatId).toBe(CHAT_ID);
      expect(telegram.calls).toEqual([]);
    });

    it('does nothing for a group that was not linked', async () => {
      const h = await newHousehold(test.db, { telegramGroupChatId: CHAT_ID });
      const { bot } = newTestBot(test.db);

      await bot.handleUpdate(migrateUpdate(-4242, -5000));

      expect((await reload(h.id)).telegramGroupChatId).toBe(CHAT_ID);
    });
  });
});
