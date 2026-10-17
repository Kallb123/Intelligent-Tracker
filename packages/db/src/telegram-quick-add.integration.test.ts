import type { QuickAddTask } from '@tracker/core';
import { UK_TEMPLATES } from '@tracker/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Database, type DbHandle } from './client.js';
import { runMigrations } from './migrate.js';
import { household, member, quickAddDraft, template } from './schema/index.js';
import {
  createQuickAddDraft,
  findQuickAddDraft,
  pruneQuickAddDrafts,
  QUICK_ADD_DRAFT_TTL_MS,
  recordQuickAddCard,
  takeQuickAddDraft,
} from './telegram-quick-add.js';
import { listMembers } from './members.js';
import { createTestDatabase, type TestDatabase } from './test-db.js';
import { listTemplates } from './templates.js';
import { eq } from 'drizzle-orm';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

const NOW = new Date('2026-07-10T18:00:00Z');
const TASK: QuickAddTask = {
  title: 'Hoover',
  scheduleKind: 'once',
  allDay: true,
  assigneeIds: [],
  workingDaysOnly: false,
  remindOffsetDays: 0,
  reminderSlot: 'evening',
  milestones: [],
};

describe.skipIf(!adminUrl)('quick-add drafts (integration)', () => {
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

  async function setup(name = 'Alex') {
    const [h] = await db.insert(household).values({ name: 'Test' }).returning();
    if (!h) throw new Error('insert failed');
    seq += 1;
    const [m] = await db
      .insert(member)
      .values({ householdId: h.id, name, username: `${name.toLowerCase()}${seq}` })
      .returning();
    if (!m) throw new Error('insert failed');
    return { h, m };
  }

  const later = (ms: number) => new Date(NOW.getTime() + ms);

  it('stores the parsed task for its author, and notes the card it was sent as', async () => {
    const { h, m } = await setup();

    const draft = await createQuickAddDraft(db, {
      householdId: h.id,
      memberId: m.id,
      task: TASK,
      now: NOW,
    });
    await recordQuickAddCard(db, draft.id, {
      telegramChatId: -1_001_234_567_890,
      telegramMessageId: 7,
    });

    expect(await findQuickAddDraft(db, { id: draft.id, householdId: h.id, now: NOW })).toEqual({
      ...draft,
      telegramChatId: -1_001_234_567_890,
      telegramMessageId: 7,
    });
    expect(draft).toMatchObject({ householdId: h.id, memberId: m.id, task: TASK, createdAt: NOW });
  });

  it('does not find a draft of another household', async () => {
    const { h, m } = await setup();
    const other = await setup('Jo');
    const draft = await createQuickAddDraft(db, {
      householdId: h.id,
      memberId: m.id,
      task: TASK,
      now: NOW,
    });

    expect(
      await findQuickAddDraft(db, { id: draft.id, householdId: other.h.id, now: NOW }),
    ).toBeNull();
    expect(
      await takeQuickAddDraft(db, { id: draft.id, householdId: other.h.id, now: NOW }),
    ).toBeNull();
    expect(await db.select().from(quickAddDraft)).toHaveLength(1);
  });

  it('hands a draft to one taker only, however many ask at once', async () => {
    const { h, m } = await setup();
    const draft = await createQuickAddDraft(db, {
      householdId: h.id,
      memberId: m.id,
      task: TASK,
      now: NOW,
    });

    const takers = await Promise.all(
      Array.from({ length: 5 }, () =>
        takeQuickAddDraft(db, { id: draft.id, householdId: h.id, now: NOW }),
      ),
    );

    expect(takers.filter((taken) => taken !== null)).toEqual([draft]);
    expect(await db.select().from(quickAddDraft)).toEqual([]);
  });

  it('puts a draft back when the transaction that took it fails', async () => {
    const { h, m } = await setup();
    const draft = await createQuickAddDraft(db, {
      householdId: h.id,
      memberId: m.id,
      task: TASK,
      now: NOW,
    });

    await expect(
      db.transaction(async (tx) => {
        await takeQuickAddDraft(tx, { id: draft.id, householdId: h.id, now: NOW });
        throw new Error('save failed');
      }),
    ).rejects.toThrow('save failed');

    expect(
      await findQuickAddDraft(db, { id: draft.id, householdId: h.id, now: NOW }),
    ).not.toBeNull();
  });

  it('stops counting a draft once its day is up', async () => {
    const { h, m } = await setup();
    const draft = await createQuickAddDraft(db, {
      householdId: h.id,
      memberId: m.id,
      task: TASK,
      now: NOW,
    });
    const key = { id: draft.id, householdId: h.id };

    expect(
      await findQuickAddDraft(db, { ...key, now: later(QUICK_ADD_DRAFT_TTL_MS - 1) }),
    ).not.toBeNull();
    expect(await findQuickAddDraft(db, { ...key, now: later(QUICK_ADD_DRAFT_TTL_MS) })).toBeNull();
    expect(await takeQuickAddDraft(db, { ...key, now: later(QUICK_ADD_DRAFT_TTL_MS) })).toBeNull();
    expect(await db.select().from(quickAddDraft)).toHaveLength(1);
  });

  it('prunes the drafts that have expired, and only those', async () => {
    const { h, m } = await setup();
    const make = (now: Date) =>
      createQuickAddDraft(db, { householdId: h.id, memberId: m.id, task: TASK, now });
    const old = await make(later(-QUICK_ADD_DRAFT_TTL_MS - 1));
    const fresh = await make(later(-QUICK_ADD_DRAFT_TTL_MS + 1000));

    expect(await pruneQuickAddDrafts(db, { now: NOW })).toBe(1);
    expect((await db.select().from(quickAddDraft)).map((d) => d.id)).toEqual([fresh.id]);
    expect(old.id).not.toBe(fresh.id);
    expect(await pruneQuickAddDrafts(db, { now: NOW })).toBe(0);
  });

  it('goes with its household or its author', async () => {
    const { h, m } = await setup();
    await createQuickAddDraft(db, { householdId: h.id, memberId: m.id, task: TASK, now: NOW });
    await db.delete(member).where(eq(member.id, m.id));
    expect(await db.select().from(quickAddDraft)).toEqual([]);

    const again = await setup('Sam');
    await createQuickAddDraft(db, {
      householdId: again.h.id,
      memberId: again.m.id,
      task: TASK,
      now: NOW,
    });
    await db.delete(household).where(eq(household.id, again.h.id));
    expect(await db.select().from(quickAddDraft)).toEqual([]);
  });

  describe('what quick-add reads', () => {
    it('lists the household’s members by name', async () => {
      const { h } = await setup('Zed');
      await db.insert(member).values({ householdId: h.id, name: 'Alex', username: 'alex-x' });
      const other = await setup('Jo');

      expect((await listMembers(db, h.id)).map((m) => m.name)).toEqual(['Alex', 'Zed']);
      expect((await listMembers(db, other.h.id)).map((m) => m.name)).toEqual(['Jo']);
    });

    it('lists the UK templates, then the household’s own by title', async () => {
      const { h } = await setup();
      const other = await setup('Jo');
      const defaults = { leadTimeDays: 3 };
      await db.insert(template).values([
        { householdId: h.id, title: 'Zebra', keywords: ['zebra'], defaults },
        { householdId: h.id, title: 'Aardvark', keywords: ['aardvark'], defaults },
        { householdId: other.h.id, title: 'Not mine', keywords: ['x'], defaults },
      ]);

      const templates = await listTemplates(db, h.id);

      expect(templates.slice(0, UK_TEMPLATES.length)).toEqual(UK_TEMPLATES);
      expect(templates.slice(UK_TEMPLATES.length)).toMatchObject([
        { title: 'Aardvark', builtIn: false, keywords: ['aardvark'], defaults },
        { title: 'Zebra', builtIn: false },
      ]);
    });
  });
});
