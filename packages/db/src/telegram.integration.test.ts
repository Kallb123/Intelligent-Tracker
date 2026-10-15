import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Database, type DbHandle } from './client.js';
import { uniqueViolation } from './errors.js';
import { runMigrations } from './migrate.js';
import { household, member, notification, type NewNotification } from './schema/index.js';
import {
  findHouseholdByTelegramChat,
  findMemberByTelegramUserId,
  issueGroupLinkCode,
  issueMemberLinkCode,
  migrateTelegramGroupChat,
  redeemGroupLinkCode,
  redeemMemberLinkCode,
  TELEGRAM_LINK_CODE_TTL_MS,
  telegramMessageNotifications,
  unlinkGroup,
  unlinkMember,
} from './telegram.js';
import { createTestDatabase, type TestDatabase } from './test-db.js';
import { hashToken } from './tokens.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

const NOW = new Date('2026-07-10T18:00:00Z');
const CHAT = -1_001_234_567_890;
const USER = 5_000_000_001;

describe.skipIf(!adminUrl)('telegram linking (integration)', () => {
  let testDb: TestDatabase;
  let handle: DbHandle;
  let db: Database;
  let seq = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase(adminUrl as string);
    await runMigrations({ databaseUrl: testDb.url });
    handle = createDb(testDb.url);
    db = handle.db;
  });

  afterAll(async () => {
    await handle?.close();
    await testDb?.drop();
  });

  beforeEach(async () => {
    await db.delete(household);
  });

  async function newHousehold() {
    const [h] = await db.insert(household).values({ name: 'Test' }).returning();
    if (!h) throw new Error('insert failed');
    return h;
  }

  async function newMember(householdId: string, name = 'Alex') {
    seq += 1;
    const [m] = await db
      .insert(member)
      .values({ householdId, name, username: `${name.toLowerCase()}${seq}` })
      .returning();
    if (!m) throw new Error('insert failed');
    return m;
  }

  const reload = async (id: string) => {
    const [h] = await db.select().from(household).where(eq(household.id, id));
    if (!h) throw new Error('missing');
    return h;
  };
  const reloadMember = async (id: string) => {
    const [m] = await db.select().from(member).where(eq(member.id, id));
    if (!m) throw new Error('missing');
    return m;
  };
  const later = (ms: number) => new Date(NOW.getTime() + ms);

  describe('group link code', () => {
    it('is stored as a hash with an expiry, and replaced by the next code', async () => {
      const h = await newHousehold();

      const first = await issueGroupLinkCode(db, h.id, { now: NOW });
      const second = await issueGroupLinkCode(db, h.id, { now: NOW });

      expect(first.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first.code).not.toBe(second.code);
      expect(second.expiresAt).toEqual(later(TELEGRAM_LINK_CODE_TTL_MS));
      expect(await reload(h.id)).toMatchObject({
        telegramGroupLinkCode: hashToken(second.code),
        telegramGroupLinkExpiresAt: second.expiresAt,
      });
      expect(await redeemGroupLinkCode(db, first.code, CHAT, { now: NOW })).toBeNull();
    });

    it('links the group once and spends the code', async () => {
      const h = await newHousehold();
      const { code } = await issueGroupLinkCode(db, h.id, { now: NOW });

      expect(await redeemGroupLinkCode(db, code, CHAT, { now: later(60_000) })).toBe(h.id);

      expect(await reload(h.id)).toMatchObject({
        telegramGroupChatId: CHAT,
        telegramGroupLinkCode: null,
        telegramGroupLinkExpiresAt: null,
      });
      expect(await redeemGroupLinkCode(db, code, -100, { now: later(60_000) })).toBeNull();
      expect((await reload(h.id)).telegramGroupChatId).toBe(CHAT);
    });

    it('rejects unknown and expired codes', async () => {
      const h = await newHousehold();
      const { code } = await issueGroupLinkCode(db, h.id, { now: NOW });

      expect(await redeemGroupLinkCode(db, 'nope', CHAT, { now: NOW })).toBeNull();
      expect(
        await redeemGroupLinkCode(db, code, CHAT, { now: later(TELEGRAM_LINK_CODE_TTL_MS) }),
      ).toBeNull();
      expect((await reload(h.id)).telegramGroupChatId).toBeNull();
    });

    it('refuses a chat another household is linked to, and keeps the code', async () => {
      const taken = await newHousehold();
      await db
        .update(household)
        .set({ telegramGroupChatId: CHAT })
        .where(eq(household.id, taken.id));
      const h = await newHousehold();
      const { code } = await issueGroupLinkCode(db, h.id, { now: NOW });

      expect(await redeemGroupLinkCode(db, code, CHAT, { now: NOW })).toBeNull();
      expect((await reload(h.id)).telegramGroupLinkCode).toBe(hashToken(code));

      await unlinkGroup(db, taken.id);
      expect(await redeemGroupLinkCode(db, code, CHAT, { now: NOW })).toBe(h.id);
    });

    it('lets only one of two households win a chat they redeem at once', async () => {
      const [a, b] = [await newHousehold(), await newHousehold()];
      const [codeA, codeB] = [
        await issueGroupLinkCode(db, a.id, { now: NOW }),
        await issueGroupLinkCode(db, b.id, { now: NOW }),
      ];

      const results = await Promise.all([
        redeemGroupLinkCode(db, codeA.code, CHAT, { now: NOW }),
        redeemGroupLinkCode(db, codeB.code, CHAT, { now: NOW }),
      ]);

      expect(results.filter((r) => r !== null)).toHaveLength(1);
      const linked = [await reload(a.id), await reload(b.id)].filter(
        (h) => h.telegramGroupChatId === CHAT,
      );
      expect(linked).toHaveLength(1);
    });

    it('is backed by a unique chat id, which unlinked households (NULL) do not share', async () => {
      const [a, b] = [await newHousehold(), await newHousehold()];
      await db.update(household).set({ telegramGroupChatId: CHAT }).where(eq(household.id, a.id));

      const err = await db
        .update(household)
        .set({ telegramGroupChatId: CHAT })
        .where(eq(household.id, b.id))
        .catch((e: unknown) => e);

      expect(uniqueViolation(err)).toBe('household_telegram_group_chat_id_unique');
      expect((await reload(b.id)).telegramGroupChatId).toBeNull();
      await newHousehold();
    });

    it('lets a household link its own chat again', async () => {
      const h = await newHousehold();
      await db.update(household).set({ telegramGroupChatId: CHAT });
      const { code } = await issueGroupLinkCode(db, h.id, { now: NOW });

      expect(await redeemGroupLinkCode(db, code, CHAT, { now: NOW })).toBe(h.id);
    });

    it('unlinks the group and forgets a pending code', async () => {
      const h = await newHousehold();
      await issueGroupLinkCode(db, h.id, { now: NOW });
      await db.update(household).set({ telegramGroupChatId: CHAT });

      await unlinkGroup(db, h.id);

      expect(await reload(h.id)).toMatchObject({
        telegramGroupChatId: null,
        telegramGroupLinkCode: null,
        telegramGroupLinkExpiresAt: null,
      });
    });

    it('finds the household of a chat, and follows a supergroup migration', async () => {
      const h = await newHousehold();
      await db.update(household).set({ telegramGroupChatId: -4_567 });

      expect((await findHouseholdByTelegramChat(db, -4_567))?.id).toBe(h.id);
      expect(await findHouseholdByTelegramChat(db, CHAT)).toBeNull();

      expect(await migrateTelegramGroupChat(db, -4_567, CHAT)).toBe(h.id);
      expect(await migrateTelegramGroupChat(db, -4_567, -1)).toBeNull();
      expect(await findHouseholdByTelegramChat(db, -4_567)).toBeNull();
      expect((await findHouseholdByTelegramChat(db, CHAT))?.id).toBe(h.id);
    });
  });

  describe('member link code', () => {
    it('links the Telegram user once and spends the code', async () => {
      const h = await newHousehold();
      const alex = await newMember(h.id);
      const { code, expiresAt } = await issueMemberLinkCode(db, alex.id, { now: NOW });
      expect(expiresAt).toEqual(later(TELEGRAM_LINK_CODE_TTL_MS));
      expect((await reloadMember(alex.id)).telegramLinkCode).toBe(hashToken(code));

      const linked = await redeemMemberLinkCode(db, code, USER, { now: later(1000) });

      expect(linked).toEqual({ memberId: alex.id, householdId: h.id, name: 'Alex' });
      expect(await reloadMember(alex.id)).toMatchObject({
        telegramUserId: USER,
        telegramLinkCode: null,
        telegramLinkExpiresAt: null,
      });
      expect((await findMemberByTelegramUserId(db, USER))?.id).toBe(alex.id);
      expect(await redeemMemberLinkCode(db, code, USER + 1, { now: later(1000) })).toBeNull();
      expect((await reloadMember(alex.id)).telegramUserId).toBe(USER);
    });

    it('rejects unknown and expired codes, and a replaced one', async () => {
      const h = await newHousehold();
      const alex = await newMember(h.id);
      const old = await issueMemberLinkCode(db, alex.id, { now: NOW });
      const fresh = await issueMemberLinkCode(db, alex.id, { now: NOW });

      expect(await redeemMemberLinkCode(db, 'nope', USER, { now: NOW })).toBeNull();
      expect(await redeemMemberLinkCode(db, old.code, USER, { now: NOW })).toBeNull();
      expect(
        await redeemMemberLinkCode(db, fresh.code, USER, {
          now: later(TELEGRAM_LINK_CODE_TTL_MS),
        }),
      ).toBeNull();
      expect(await findMemberByTelegramUserId(db, USER)).toBeNull();
    });

    it('moves a Telegram user who was linked to another member', async () => {
      const h = await newHousehold();
      const alex = await newMember(h.id, 'Alex');
      const sam = await newMember(h.id, 'Sam');
      await db.update(member).set({ telegramUserId: USER }).where(eq(member.id, alex.id));
      const { code } = await issueMemberLinkCode(db, sam.id, { now: NOW });

      expect(await redeemMemberLinkCode(db, code, USER, { now: NOW })).toMatchObject({
        memberId: sam.id,
      });

      expect((await reloadMember(alex.id)).telegramUserId).toBeNull();
      expect((await findMemberByTelegramUserId(db, USER))?.id).toBe(sam.id);
    });

    it('re-links a member to a different Telegram user', async () => {
      const h = await newHousehold();
      const alex = await newMember(h.id);
      await db.update(member).set({ telegramUserId: USER });
      const { code } = await issueMemberLinkCode(db, alex.id, { now: NOW });

      await redeemMemberLinkCode(db, code, USER + 1, { now: NOW });

      expect((await reloadMember(alex.id)).telegramUserId).toBe(USER + 1);
      expect(await findMemberByTelegramUserId(db, USER)).toBeNull();
    });

    it('lets only one of two racing redemptions win', async () => {
      const h = await newHousehold();
      const alex = await newMember(h.id);
      const { code } = await issueMemberLinkCode(db, alex.id, { now: NOW });

      const results = await Promise.all([
        redeemMemberLinkCode(db, code, USER, { now: NOW }),
        redeemMemberLinkCode(db, code, USER + 1, { now: NOW }),
      ]);

      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it('unlinks the member and forgets a pending code', async () => {
      const h = await newHousehold();
      const alex = await newMember(h.id);
      await issueMemberLinkCode(db, alex.id, { now: NOW });
      await db.update(member).set({ telegramUserId: USER });

      await unlinkMember(db, alex.id);

      expect(await reloadMember(alex.id)).toMatchObject({
        telegramUserId: null,
        telegramLinkCode: null,
        telegramLinkExpiresAt: null,
      });
    });
  });

  describe('telegramMessageNotifications', () => {
    it('returns the group rows of one message of one household, in delivery order', async () => {
      const h = await newHousehold();
      const other = await newHousehold();
      let n = 0;
      const queue = async (values: Partial<NewNotification>) => {
        n += 1;
        const [row] = await db
          .insert(notification)
          .values({
            householdId: h.id,
            memberId: null,
            channel: 'telegram_group',
            dedupeKey: `t:${n}`,
            nextAttemptAt: NOW,
            payload: {
              type: 'reminder',
              kind: 'due',
              taskId: '00000000-0000-4000-8000-000000000001',
              occurrenceId: '00000000-0000-4000-8000-000000000002',
              taskTitle: 'Bins',
              dueDate: '2026-07-10',
              dueAt: null,
              fireAt: NOW.toISOString(),
              assigneeId: null,
            },
            ...values,
          })
          .returning();
        return row?.id ?? '';
      };
      const second = await queue({ telegramMessageId: 7, nextAttemptAt: later(1000) });
      const first = await queue({ telegramMessageId: 7 });
      await queue({ telegramMessageId: 8 });
      await queue({ telegramMessageId: null });
      await queue({ householdId: other.id, telegramMessageId: 7 });

      const rows = await telegramMessageNotifications(db, h.id, 7);

      expect(rows.map((r) => r.id)).toEqual([first, second]);
    });
  });
});
