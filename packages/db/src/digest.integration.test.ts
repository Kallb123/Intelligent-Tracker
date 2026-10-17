import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Database, type DbHandle } from './client.js';
import { AGENDA_LIMIT, loadAgenda } from './digest.js';
import { runMigrations } from './migrate.js';
import {
  bankHoliday,
  household,
  member,
  occurrence,
  task,
  telegramDigest,
  type NewOccurrence,
  type NewTask,
} from './schema/index.js';
import {
  claimDigest,
  DIGEST_LOG_RETENTION_MS,
  linkedHouseholds,
  pruneDigests,
  recordDigestMessage,
  releaseDigest,
} from './telegram-digests.js';
import { createTestDatabase, type TestDatabase } from './test-db.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

const at = (iso: string): Date => new Date(iso);

// Wednesday 15 July 2026, 11:00 in London (BST).
const NOW = at('2026-07-15T10:00:00Z');

describe.skipIf(!adminUrl)('agenda and digest log (integration)', () => {
  let testDb: TestDatabase;
  let handle: DbHandle;
  let db: Database;

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
    await db.delete(bankHoliday);
  });

  async function newHousehold(values: Partial<typeof household.$inferInsert> = {}) {
    const [h] = await db
      .insert(household)
      .values({ name: 'Test', ...values })
      .returning();
    if (!h) throw new Error('insert failed');
    return h;
  }

  let members = 0;
  async function newMember(householdId: string, name: string) {
    members += 1;
    const [m] = await db
      .insert(member)
      .values({ householdId, name, username: `${name.toLowerCase()}${members}` })
      .returning();
    if (!m) throw new Error('insert failed');
    return m;
  }

  /** A task with one open occurrence. */
  async function addJob(
    householdId: string,
    title: string,
    occ: Partial<NewOccurrence> = {},
    taskValues: Partial<NewTask> = {},
  ) {
    const [t] = await db
      .insert(task)
      .values({ householdId, title, scheduleKind: 'once', ...taskValues })
      .returning();
    if (!t) throw new Error('insert failed');
    const [o] = await db
      .insert(occurrence)
      .values({ taskId: t.id, status: 'active', ...occ })
      .returning();
    if (!o) throw new Error('insert failed');
    return { t, o };
  }

  describe('loadAgenda', () => {
    /** The fixture: a spread of jobs around Wednesday 15 July, for Sam's household. */
    async function fixture() {
      const h = await newHousehold();
      const sam = await newMember(h.id, 'Sam');
      const jo = await newMember(h.id, 'Jo');
      await addJob(h.id, 'Overdue all-day', { dueDate: '2026-07-13', assigneeId: sam.id });
      await addJob(h.id, 'Overdue timed', { dueAt: at('2026-07-15T08:00:00Z'), assigneeId: jo.id });
      await addJob(h.id, 'Due today', { dueDate: '2026-07-15', assigneeId: sam.id });
      await addJob(
        h.id,
        'Due this evening',
        { dueAt: at('2026-07-15T17:30:00Z') },
        { allDay: false, dueAt: at('2026-07-15T17:30:00Z'), effortMinutes: 20 },
      );
      await addJob(h.id, 'Starts soon', {
        status: 'upcoming',
        dueDate: '2026-07-25',
        startAt: at('2026-07-17T08:00:00Z'),
      });
      await addJob(h.id, 'Due tomorrow', { status: 'upcoming', dueDate: '2026-07-16' });
      await addJob(h.id, 'Due in six days', { status: 'upcoming', dueDate: '2026-07-21' });
      await addJob(h.id, 'Due in a week', { status: 'upcoming', dueDate: '2026-07-22' });
      await addJob(h.id, 'Someday', {});
      return { h, sam, jo };
    }

    it('lists today, overdue first, with who and how long', async () => {
      const { h, sam } = await fixture();

      const agenda = await loadAgenda(db, h, { now: NOW, view: 'today' });

      expect(agenda.today).toBe('2026-07-15');
      expect(agenda.items.map((i) => i.title)).toEqual([
        'Overdue all-day',
        'Overdue timed',
        'Due today',
        'Due this evening',
        'Starts soon',
        'Someday',
      ]);
      expect(agenda.items[0]).toMatchObject({
        taskId: expect.any(String),
        occurrenceId: expect.any(String),
        dueDate: '2026-07-13',
        dueAt: null,
        status: 'active',
        assigneeId: sam.id,
        assigneeName: 'Sam',
        overdue: true,
        startingSoon: false,
      });
      expect(agenda.items.map((i) => i.overdue)).toEqual([true, true, false, false, false, false]);
      expect(agenda.items.map((i) => i.startingSoon)).toEqual([
        false,
        false,
        false,
        false,
        true,
        false,
      ]);
      expect(agenda.items[3]).toMatchObject({
        dueAt: at('2026-07-15T17:30:00Z'),
        assigneeId: null,
        assigneeName: null,
        effortMinutes: 20,
      });
    });

    it('lists the next seven days for the week view', async () => {
      const { h } = await fixture();

      const agenda = await loadAgenda(db, h, { now: NOW, view: 'week' });

      expect(agenda.items.map((i) => i.title)).toEqual([
        'Overdue all-day',
        'Overdue timed',
        'Due today',
        'Due this evening',
        'Due tomorrow',
        'Due in six days',
        'Starts soon',
        'Someday',
      ]);
    });

    it('keeps to one member`s jobs', async () => {
      const { h, sam } = await fixture();

      const agenda = await loadAgenda(db, h, { now: NOW, view: 'week', memberId: sam.id });

      expect(agenda.items.map((i) => i.title)).toEqual(['Overdue all-day', 'Due today']);
    });

    it('leaves out closed, snoozed, archived and other households` jobs', async () => {
      const h = await newHousehold();
      const other = await newHousehold({ telegramGroupChatId: -5 });
      await addJob(h.id, 'Open', {});
      await addJob(h.id, 'Done', { status: 'done' });
      await addJob(h.id, 'Skipped', { status: 'skipped' });
      await addJob(h.id, 'Snoozed', { snoozedUntil: at('2026-07-15T12:00:00Z') });
      await addJob(h.id, 'Snooze over', { snoozedUntil: at('2026-07-15T09:00:00Z') });
      await addJob(h.id, 'Archived', {}, { archivedAt: at('2026-07-01T00:00:00Z') });
      await addJob(other.id, 'Elsewhere', {});

      const agenda = await loadAgenda(db, h, { now: NOW, view: 'today' });

      expect(agenda.items.map((i) => i.title).sort()).toEqual(['Open', 'Snooze over']);
    });

    it('judges today by the household`s zone', async () => {
      const h = await newHousehold({ timezone: 'Pacific/Auckland' });
      // 22:00 UTC on the 15th is 10:00 on the 16th in Auckland.
      const now = at('2026-07-15T22:00:00Z');
      await addJob(h.id, 'Due yesterday there', { dueDate: '2026-07-15' });
      await addJob(h.id, 'Due today there', { dueDate: '2026-07-16' });
      await addJob(h.id, 'Due tomorrow there', { status: 'upcoming', dueDate: '2026-07-17' });

      const agenda = await loadAgenda(db, h, { now, view: 'today' });

      expect(agenda.today).toBe('2026-07-16');
      expect(agenda.items.map((i) => [i.title, i.overdue])).toEqual([
        ['Due yesterday there', true],
        ['Due today there', false],
      ]);
    });

    it('holds at most AGENDA_LIMIT items, overdue ones last to go', async () => {
      const h = await newHousehold();
      await addJob(h.id, 'Late', { dueDate: '2026-07-01' });
      for (let i = 0; i < AGENDA_LIMIT + 5; i++) await addJob(h.id, `Someday ${i}`, {});

      const agenda = await loadAgenda(db, h, { now: NOW, view: 'today' });

      expect(agenda.items).toHaveLength(AGENDA_LIMIT);
      expect(agenda.items[0]?.title).toBe('Late');
    });

    it('adds the region`s holidays for the days the view covers', async () => {
      const h = await newHousehold();
      await db.insert(bankHoliday).values([
        { region: 'england-and-wales', date: '2026-07-14', title: 'Yesterday' },
        { region: 'england-and-wales', date: '2026-07-15', title: 'Today' },
        { region: 'england-and-wales', date: '2026-07-21', title: 'In six days' },
        { region: 'england-and-wales', date: '2026-07-22', title: 'In seven days' },
        { region: 'england-and-wales', date: '2026-07-23', title: 'In eight days' },
        { region: 'scotland', date: '2026-07-16', title: 'Scottish' },
      ]);
      const titles = async (view: 'today' | 'week') =>
        (await loadAgenda(db, h, { now: NOW, view })).holidays.map((x) => x.title);

      expect(await titles('today')).toEqual(['Today', 'In six days', 'In seven days']);
      expect(await titles('week')).toEqual(['Today', 'In six days']);
    });
  });

  describe('the digest log', () => {
    const key = (householdId: string) => ({
      householdId,
      kind: 'morning' as const,
      localDate: '2026-07-15',
    });

    it('lets one caller claim a digest per household, kind and date', async () => {
      const a = await newHousehold();
      const b = await newHousehold();

      expect(await claimDigest(db, { ...key(a.id), now: NOW })).toBe(true);
      expect(await claimDigest(db, { ...key(a.id), now: NOW })).toBe(false);
      expect(await claimDigest(db, { ...key(b.id), now: NOW })).toBe(true);
      expect(await claimDigest(db, { ...key(a.id), kind: 'week_ahead', now: NOW })).toBe(true);
      expect(await claimDigest(db, { ...key(a.id), localDate: '2026-07-16', now: NOW })).toBe(true);
    });

    it('lets two racing callers claim it once', async () => {
      const h = await newHousehold();
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => claimDigest(db, { ...key(h.id), now: NOW })),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('can be claimed again once released', async () => {
      const h = await newHousehold();
      await claimDigest(db, { ...key(h.id), now: NOW });

      await releaseDigest(db, key(h.id));

      expect(await claimDigest(db, { ...key(h.id), now: NOW })).toBe(true);
    });

    it('records the message it was sent as', async () => {
      const h = await newHousehold();
      await claimDigest(db, { ...key(h.id), now: NOW });
      await claimDigest(db, { ...key(h.id), kind: 'week_ahead', now: NOW });

      await recordDigestMessage(db, {
        ...key(h.id),
        telegramChatId: -1_001_234_567_890,
        telegramMessageId: 42,
      });

      const rows = await db.select().from(telegramDigest);
      expect(rows.map((r) => [r.kind, r.telegramChatId, r.telegramMessageId]).sort()).toEqual([
        ['morning', -1_001_234_567_890, 42],
        ['week_ahead', null, null],
      ]);
    });

    it('deletes the log with its household', async () => {
      const h = await newHousehold();
      await claimDigest(db, { ...key(h.id), now: NOW });
      await db.delete(household);
      expect(await db.select().from(telegramDigest)).toEqual([]);
    });

    it('prunes claims older than the retention only', async () => {
      const h = await newHousehold();
      const old = new Date(NOW.getTime() - DIGEST_LOG_RETENTION_MS - 1);
      const recent = new Date(NOW.getTime() - DIGEST_LOG_RETENTION_MS + 1);
      await claimDigest(db, { ...key(h.id), localDate: '2026-06-01', now: old });
      await claimDigest(db, { ...key(h.id), localDate: '2026-06-15', now: recent });

      expect(await pruneDigests(db, { now: NOW })).toBe(1);
      expect((await db.select().from(telegramDigest)).map((r) => r.localDate)).toEqual([
        '2026-06-15',
      ]);
      expect(await pruneDigests(db, { now: NOW })).toBe(0);
    });
  });

  describe('linkedHouseholds', () => {
    it('lists the households with a Telegram group', async () => {
      await newHousehold({ name: 'No group' });
      const a = await newHousehold({ name: 'A', telegramGroupChatId: -1 });
      const b = await newHousehold({ name: 'B', telegramGroupChatId: -2 });

      const linked = await linkedHouseholds(db);

      expect(linked.map((h) => h.id).sort()).toEqual([a.id, b.id].sort());
    });
  });
});
