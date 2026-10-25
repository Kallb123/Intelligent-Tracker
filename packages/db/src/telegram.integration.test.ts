import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Database, type DbHandle } from './client.js';
import { uniqueViolation } from './errors.js';
import { runMigrations } from './migrate.js';
import {
  activity,
  household,
  member,
  notification,
  occurrence,
  task,
  taskMilestone,
  type NewNotification,
} from './schema/index.js';
import {
  findHouseholdById,
  findHouseholdByTelegramChat,
  findMemberByTelegramUserId,
  findMembersByIds,
  issueGroupLinkCode,
  issueMemberLinkCode,
  migrateTelegramGroupChat,
  occurrenceStates,
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

    it('refuses a chat another household is linked to, and spends the code', async () => {
      const taken = await newHousehold();
      await db
        .update(household)
        .set({ telegramGroupChatId: CHAT })
        .where(eq(household.id, taken.id));
      const h = await newHousehold();
      await db.update(household).set({ telegramGroupChatId: -77 }).where(eq(household.id, h.id));
      const { code } = await issueGroupLinkCode(db, h.id, { now: NOW });

      expect(await redeemGroupLinkCode(db, code, CHAT, { now: NOW })).toBeNull();

      // Spent (it was posted in a group that is not ours), and nobody's link changed.
      expect(await reload(h.id)).toMatchObject({
        telegramGroupChatId: -77,
        telegramGroupLinkCode: null,
        telegramGroupLinkExpiresAt: null,
      });
      expect((await reload(taken.id)).telegramGroupChatId).toBe(CHAT);
      await unlinkGroup(db, taken.id);
      expect(await redeemGroupLinkCode(db, code, CHAT, { now: NOW })).toBeNull();
      expect((await reload(h.id)).telegramGroupChatId).toBe(-77);
    });

    it('spends the code of the loser when two households race for one chat', async () => {
      const [a, b] = [await newHousehold(), await newHousehold()];
      const [codeA, codeB] = [
        await issueGroupLinkCode(db, a.id, { now: NOW }),
        await issueGroupLinkCode(db, b.id, { now: NOW }),
      ];

      await Promise.all([
        redeemGroupLinkCode(db, codeA.code, CHAT, { now: NOW }),
        redeemGroupLinkCode(db, codeB.code, CHAT, { now: NOW }),
      ]);

      for (const h of [await reload(a.id), await reload(b.id)]) {
        expect(h.telegramGroupLinkCode).toBeNull();
      }
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

      expect(linked).toEqual({
        status: 'linked',
        memberId: alex.id,
        householdId: h.id,
        name: 'Alex',
      });
      expect(await reloadMember(alex.id)).toMatchObject({
        telegramUserId: USER,
        telegramLinkCode: null,
        telegramLinkExpiresAt: null,
      });
      expect((await findMemberByTelegramUserId(db, USER))?.id).toBe(alex.id);
      expect(await redeemMemberLinkCode(db, code, USER + 1, { now: later(1000) })).toEqual({
        status: 'invalid',
      });
      expect((await reloadMember(alex.id)).telegramUserId).toBe(USER);
    });

    it('rejects unknown and expired codes, and a replaced one', async () => {
      const h = await newHousehold();
      const alex = await newMember(h.id);
      const old = await issueMemberLinkCode(db, alex.id, { now: NOW });
      const fresh = await issueMemberLinkCode(db, alex.id, { now: NOW });

      const invalid = { status: 'invalid' };
      expect(await redeemMemberLinkCode(db, 'nope', USER, { now: NOW })).toEqual(invalid);
      expect(await redeemMemberLinkCode(db, old.code, USER, { now: NOW })).toEqual(invalid);
      expect(
        await redeemMemberLinkCode(db, fresh.code, USER, {
          now: later(TELEGRAM_LINK_CODE_TTL_MS),
        }),
      ).toEqual(invalid);
      expect(await findMemberByTelegramUserId(db, USER)).toBeNull();
    });

    it('refuses a Telegram user who is linked to another member, and keeps the code', async () => {
      const h = await newHousehold();
      const alex = await newMember(h.id, 'Alex');
      const sam = await newMember(h.id, 'Sam');
      await db.update(member).set({ telegramUserId: USER }).where(eq(member.id, alex.id));
      const { code } = await issueMemberLinkCode(db, sam.id, { now: NOW });

      expect(await redeemMemberLinkCode(db, code, USER, { now: NOW })).toEqual({
        status: 'already_linked',
        name: 'Alex',
      });

      expect((await reloadMember(alex.id)).telegramUserId).toBe(USER);
      expect(await reloadMember(sam.id)).toMatchObject({
        telegramUserId: null,
        telegramLinkCode: hashToken(code),
      });

      // Once Alex has disconnected in the app, the same code works.
      await unlinkMember(db, alex.id);
      expect(await redeemMemberLinkCode(db, code, USER, { now: NOW })).toMatchObject({
        status: 'linked',
        memberId: sam.id,
      });
    });

    it('refuses a Telegram user linked to a member of another household', async () => {
      const [mine, theirs] = [await newHousehold(), await newHousehold()];
      const victim = await newMember(theirs.id, 'Victim');
      const attacker = await newMember(mine.id, 'Attacker');
      await db.update(member).set({ telegramUserId: USER }).where(eq(member.id, victim.id));
      const { code } = await issueMemberLinkCode(db, attacker.id, { now: NOW });

      expect(await redeemMemberLinkCode(db, code, USER, { now: NOW })).toEqual({
        status: 'already_linked',
        name: 'Victim',
      });
      expect((await findMemberByTelegramUserId(db, USER))?.id).toBe(victim.id);
    });

    it('lets a member link the Telegram user they already have', async () => {
      const h = await newHousehold();
      const alex = await newMember(h.id);
      await db.update(member).set({ telegramUserId: USER }).where(eq(member.id, alex.id));
      const { code } = await issueMemberLinkCode(db, alex.id, { now: NOW });

      expect(await redeemMemberLinkCode(db, code, USER, { now: NOW })).toMatchObject({
        status: 'linked',
        memberId: alex.id,
      });
      expect(await reloadMember(alex.id)).toMatchObject({
        telegramUserId: USER,
        telegramLinkCode: null,
      });
    });

    it('lets one Telegram user win when two members redeem codes at once', async () => {
      const h = await newHousehold();
      const [alex, sam] = [await newMember(h.id, 'Alex'), await newMember(h.id, 'Sam')];
      const [codeA, codeB] = [
        await issueMemberLinkCode(db, alex.id, { now: NOW }),
        await issueMemberLinkCode(db, sam.id, { now: NOW }),
      ];

      const results = await Promise.all([
        redeemMemberLinkCode(db, codeA.code, USER, { now: NOW }),
        redeemMemberLinkCode(db, codeB.code, USER, { now: NOW }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual(['already_linked', 'linked']);
      const [winner] = await db.select().from(member).where(eq(member.telegramUserId, USER));
      expect(winner).toBeDefined();
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

      expect(results.filter((r) => r.status === 'linked')).toHaveLength(1);
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
    let n = 0;
    const queue = async (householdId: string, values: Partial<NewNotification>) => {
      n += 1;
      const [row] = await db
        .insert(notification)
        .values({
          householdId,
          memberId: null,
          channel: 'telegram_group',
          dedupeKey: `t:${n}`,
          nextAttemptAt: NOW,
          telegramChatId: CHAT,
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

    it('returns the group rows of one message of one household, in delivery order', async () => {
      const h = await newHousehold();
      const other = await newHousehold();
      const second = await queue(h.id, { telegramMessageId: 7, nextAttemptAt: later(1000) });
      const first = await queue(h.id, { telegramMessageId: 7 });
      await queue(h.id, { telegramMessageId: 8 });
      await queue(h.id, { telegramMessageId: null, telegramChatId: null });
      await queue(other.id, { telegramMessageId: 7 });

      const rows = await telegramMessageNotifications(db, h.id, CHAT, 7);

      expect(rows.map((r) => r.id)).toEqual([first, second]);
    });

    it('keeps the messages of two chats with the same id apart', async () => {
      const h = await newHousehold();
      const inOldGroup = await queue(h.id, { telegramChatId: -4_567, telegramMessageId: 7 });
      const inNewGroup = await queue(h.id, { telegramChatId: CHAT, telegramMessageId: 7 });

      const ids = async (chatId: number) =>
        (await telegramMessageNotifications(db, h.id, chatId, 7)).map((r) => r.id);

      expect(await ids(-4_567)).toEqual([inOldGroup]);
      expect(await ids(CHAT)).toEqual([inNewGroup]);
      expect(await ids(-1)).toEqual([]);
    });

    it('moves the messages of a group to its supergroup id when it migrates', async () => {
      const h = await newHousehold();
      const other = await newHousehold();
      await db.update(household).set({ telegramGroupChatId: -4_567 }).where(eq(household.id, h.id));
      const mine = await queue(h.id, { telegramChatId: -4_567, telegramMessageId: 7 });
      const theirs = await queue(other.id, { telegramChatId: -4_567, telegramMessageId: 7 });

      await migrateTelegramGroupChat(db, -4_567, CHAT);

      expect((await telegramMessageNotifications(db, h.id, CHAT, 7)).map((r) => r.id)).toEqual([
        mine,
      ]);
      expect(await telegramMessageNotifications(db, h.id, -4_567, 7)).toEqual([]);
      // Another household's rows are not touched.
      expect(
        (await telegramMessageNotifications(db, other.id, -4_567, 7)).map((r) => r.id),
      ).toEqual([theirs]);
    });
  });

  describe('findHouseholdById and findMembersByIds', () => {
    it('find the household, and only the household members asked for', async () => {
      const h = await newHousehold();
      const other = await newHousehold();
      const alex = await newMember(h.id, 'Alex');
      const sam = await newMember(h.id, 'Sam');
      const stranger = await newMember(other.id, 'Stranger');

      expect((await findHouseholdById(db, h.id))?.id).toBe(h.id);
      expect(await findHouseholdById(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
      const found = await findMembersByIds(db, h.id, [alex.id, stranger.id]);
      expect(found.map((m) => m.id)).toEqual([alex.id]);
      expect((await findMembersByIds(db, h.id, [sam.id, alex.id])).map((m) => m.id).sort()).toEqual(
        [alex.id, sam.id].sort(),
      );
      expect(await findMembersByIds(db, h.id, [])).toEqual([]);
    });
  });

  describe('occurrenceStates', () => {
    async function newOccurrence(householdId: string) {
      const [t] = await db
        .insert(task)
        .values({ householdId, title: 'Bins', scheduleKind: 'once', dueDate: '2026-07-10' })
        .returning();
      const [o] = await db
        .insert(occurrence)
        .values({ taskId: t?.id ?? '', dueDate: '2026-07-10', status: 'active' })
        .returning();
      if (!t || !o) throw new Error('insert failed');
      return { task: t, occurrence: o };
    }

    const log = async (
      householdId: string,
      occ: Awaited<ReturnType<typeof newOccurrence>>,
      memberId: string | null,
      kind: string,
      createdAt: Date,
    ) => {
      await db.insert(activity).values({
        householdId,
        memberId,
        taskId: occ.task.id,
        occurrenceId: occ.occurrence.id,
        kind,
        createdAt,
      });
    };

    it('gives the status and, per kind of action, the name of the member who did it last', async () => {
      const h = await newHousehold();
      const alex = await newMember(h.id, 'Alex');
      const sam = await newMember(h.id, 'Sam');
      const occ = await newOccurrence(h.id);
      const untouched = await newOccurrence(h.id);
      await log(h.id, occ, alex.id, 'occurrence.snoozed', later(1000));
      await log(h.id, occ, sam.id, 'occurrence.snoozed', later(2000));
      await log(h.id, occ, alex.id, 'occurrence.started', later(3000));
      // Not an action on the occurrence's state.
      await log(h.id, occ, sam.id, 'task.updated', later(4000));
      await db
        .update(occurrence)
        .set({ status: 'started', snoozedUntil: later(9000) })
        .where(eq(occurrence.id, occ.occurrence.id));

      const states = await occurrenceStates(db, h.id, [occ.occurrence.id, untouched.occurrence.id]);

      expect(states.find((s) => s.occurrenceId === occ.occurrence.id)).toEqual({
        occurrenceId: occ.occurrence.id,
        status: 'started',
        snoozedUntil: later(9000),
        actors: { snoozed: 'Sam', started: 'Alex' },
        milestones: {},
      });
      expect(states.find((s) => s.occurrenceId === untouched.occurrence.id)).toEqual({
        occurrenceId: untouched.occurrence.id,
        status: 'active',
        snoozedUntil: null,
        actors: {},
        milestones: {},
      });
    });

    it('has a null name when the member is gone, and skips other households and unknown ids', async () => {
      const h = await newHousehold();
      const other = await newHousehold();
      const alex = await newMember(h.id, 'Alex');
      const occ = await newOccurrence(h.id);
      const foreign = await newOccurrence(other.id);
      await log(h.id, occ, alex.id, 'occurrence.completed', later(1000));
      await db.delete(member).where(eq(member.id, alex.id));

      const states = await occurrenceStates(db, h.id, [
        occ.occurrence.id,
        foreign.occurrence.id,
        '00000000-0000-4000-8000-000000000000',
      ]);

      expect(states).toEqual([
        {
          occurrenceId: occ.occurrence.id,
          status: 'active',
          snoozedUntil: null,
          actors: { completed: null },
          milestones: {},
        },
      ]);
      expect(await occurrenceStates(db, h.id, [])).toEqual([]);
    });

    it("gives the task's milestones: ticked or not, and who ticked each one last", async () => {
      const h = await newHousehold();
      const alex = await newMember(h.id, 'Alex');
      const sam = await newMember(h.id, 'Sam');
      const gone = await newMember(h.id, 'Gone');
      const occ = await newOccurrence(h.id);
      const other = await newOccurrence(h.id);
      const [quotes, decide, renew, untrackedTick] = await db
        .insert(taskMilestone)
        .values(
          ['Get quotes', 'Decide', 'Renew', 'Old tick'].map((title, position) => ({
            taskId: occ.task.id,
            title,
            offsetDaysBeforeDue: 30 - position,
            position,
          })),
        )
        .returning();
      if (!quotes || !decide || !renew || !untrackedTick) throw new Error('insert failed');
      const tick = async (memberId: string, milestoneId: string, createdAt: Date) => {
        await db.insert(activity).values({
          householdId: h.id,
          memberId,
          taskId: occ.task.id,
          occurrenceId: occ.occurrence.id,
          kind: 'occurrence.milestone_done',
          data: { milestoneId },
          createdAt,
        });
      };
      // Quotes was ticked by Alex, unticked, and ticked again by Sam; Decide by a member who has
      // since been deleted; Old tick has no activity row at all; Renew is not ticked.
      await tick(alex.id, quotes.id, later(1000));
      await tick(sam.id, quotes.id, later(2000));
      await tick(gone.id, decide.id, later(3000));
      await db.delete(member).where(eq(member.id, gone.id));
      // A tick on another occurrence does not leak into this one.
      await db.insert(activity).values({
        householdId: h.id,
        memberId: alex.id,
        taskId: occ.task.id,
        occurrenceId: other.occurrence.id,
        kind: 'occurrence.milestone_done',
        data: { milestoneId: renew.id },
        createdAt: later(4000),
      });
      await db
        .update(occurrence)
        .set({
          milestoneProgress: {
            [quotes.id]: later(2000).toISOString(),
            [decide.id]: later(3000).toISOString(),
            [untrackedTick.id]: later(500).toISOString(),
          },
        })
        .where(eq(occurrence.id, occ.occurrence.id));

      const [state] = await occurrenceStates(db, h.id, [occ.occurrence.id]);

      expect(state?.milestones).toEqual({
        [quotes.id]: { done: true, doneBy: 'Sam' },
        [decide.id]: { done: true, doneBy: null },
        [untrackedTick.id]: { done: true, doneBy: null },
        [renew.id]: { done: false },
      });
    });
  });
});
