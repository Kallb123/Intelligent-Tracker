import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Database, type DbHandle } from './client.js';
import { runMigrations } from './migrate.js';
import {
  completedMilestoneIds,
  inAppDedupeKey,
  MISSED_REMINDER_GRACE_MS,
  queueDueReminders,
  replanReminders,
} from './reminders.js';
import {
  household,
  member,
  notification,
  occurrence,
  reminder,
  task,
  taskMilestone,
  type NewOccurrence,
  type NewTask,
} from './schema/index.js';
import { createTestDatabase, type TestDatabase } from './test-db.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

const at = (iso: string): Date => new Date(iso);

/*
 * The fixture task is due on 20 July with a 10 day lead time and the standard profile, so at
 * `NOW` (6 July) the planner produces, all at the 19:00 evening slot (18:00Z in BST):
 * heads_up on 10 July, nudges on 15, 18 and 19 July, and due on 20 July.
 */
const NOW = at('2026-07-06T09:00:00Z');
const HEADS_UP_AT = at('2026-07-10T18:00:00Z');
const DUE_AFTER_HEADS_UP = at('2026-07-10T18:00:30Z');
const PLAN_KEYS = ['heads_up', 'nudge:2026-07-15', 'nudge:2026-07-18', 'nudge:2026-07-19', 'due'];

describe.skipIf(!adminUrl)('reminders (integration)', () => {
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

  // Every test starts from an empty database (the household delete cascades to everything).
  beforeEach(async () => {
    await db.delete(household);
  });

  async function newHousehold(values: Partial<typeof household.$inferInsert> = {}) {
    const [h] = await db
      .insert(household)
      .values({ name: 'Test', ...values })
      .returning();
    if (!h) throw new Error('insert failed');
    return h;
  }

  async function newMember(householdId: string, username: string, awayUntil?: string) {
    const [m] = await db
      .insert(member)
      .values({ householdId, name: username, username, ...(awayUntil ? { awayUntil } : {}) })
      .returning();
    if (!m) throw new Error('insert failed');
    return m;
  }

  async function newTask(householdId: string, values: Partial<NewTask> = {}) {
    const [t] = await db
      .insert(task)
      .values({
        householdId,
        title: 'Car insurance',
        scheduleKind: 'once',
        dueDate: '2026-07-20',
        leadTimeDays: 10,
        reminderProfile: 'standard',
        ...values,
      })
      .returning();
    if (!t) throw new Error('insert failed');
    return t;
  }

  async function newOccurrence(taskId: string, values: Partial<NewOccurrence> = {}) {
    const [o] = await db
      .insert(occurrence)
      .values({ taskId, dueDate: '2026-07-20', status: 'active', ...values })
      .returning();
    if (!o) throw new Error('insert failed');
    return o;
  }

  let households = 0;
  /** A household with one member, a task and its active occurrence assigned to the member. */
  async function setup(taskValues: Partial<NewTask> = {}) {
    const h = await newHousehold();
    // Usernames are unique across households.
    const alex = await newMember(h.id, `alex${(households += 1)}`);
    const t = await newTask(h.id, taskValues);
    const o = await newOccurrence(t.id, { assigneeId: alex.id });
    return { h, alex, t, o };
  }

  const reminders = () =>
    db.select().from(reminder).orderBy(asc(reminder.fireAt), asc(reminder.key));
  const planned = async () => (await reminders()).filter((r) => r.status === 'planned');
  const keys = (rows: { key: string }[]) => rows.map((r) => r.key).sort();
  const notifications = () => db.select().from(notification).orderBy(asc(notification.createdAt));

  describe('replanReminders', () => {
    it('persists the planner`s reminders for an open occurrence', async () => {
      const { alex, o } = await setup();

      const result = await replanReminders(db, { now: NOW });

      expect(result).toEqual({ occurrences: 1, planned: 5, cancelled: 0, failures: [] });
      const rows = await reminders();
      expect(keys(rows)).toEqual([...PLAN_KEYS].sort());
      expect(rows.every((r) => r.status === 'planned' && r.occurrenceId === o.id)).toBe(true);
      expect(rows.every((r) => r.memberId === alex.id && r.sentAt === null)).toBe(true);
      expect(rows[0]).toMatchObject({ key: 'heads_up', kind: 'heads_up', fireAt: HEADS_UP_AT });
      expect(rows.at(-1)).toMatchObject({ key: 'due', kind: 'due' });
    });

    it('writes nothing when nothing changed', async () => {
      await setup();
      await replanReminders(db, { now: NOW });
      const before = await reminders();

      const again = await replanReminders(db, { now: NOW });
      const later = await replanReminders(db, { now: at('2026-07-06T09:01:00Z') });

      expect(again).toEqual({ occurrences: 1, planned: 0, cancelled: 0, failures: [] });
      expect(later).toMatchObject({ planned: 0, cancelled: 0 });
      // updated_at included: not a single row was touched.
      expect(await reminders()).toEqual(before);
    });

    describe('the plan hash', () => {
      const hashOf = async (id: string) =>
        (await db.select().from(occurrence).where(eq(occurrence.id, id)))[0];

      it('is stored on the occurrence without touching its updated_at', async () => {
        const { o } = await setup();
        expect((await hashOf(o.id))?.reminderPlanHash).toBeNull();

        await replanReminders(db, { now: NOW });

        const planned = await hashOf(o.id);
        expect(planned?.reminderPlanHash).toMatch(/^[0-9a-f]{64}$/);
        expect(planned?.updatedAt).toEqual(o.updatedAt);
      });

      it('changes with the planner`s inputs, not with the clock or unrelated fields', async () => {
        const { t, o, alex } = await setup();
        await replanReminders(db, { now: NOW });
        const hash = async () => (await hashOf(o.id))?.reminderPlanHash;
        const first = await hash();

        await replanReminders(db, { now: at('2026-07-08T09:00:00Z') });
        await db.update(task).set({ title: 'Renamed' }).where(eq(task.id, t.id));
        await replanReminders(db, { now: at('2026-07-08T09:00:00Z') });
        expect(await hash()).toBe(first);

        const edits = [
          () => db.update(task).set({ leadTimeDays: 9 }).where(eq(task.id, t.id)),
          () => db.update(member).set({ awayUntil: '2026-07-08' }).where(eq(member.id, alex.id)),
          () =>
            db
              .update(occurrence)
              .set({ snoozedUntil: at('2026-07-09T10:00:00Z') })
              .where(eq(occurrence.id, o.id)),
          () => db.update(household).set({ quietHoursStart: '23:00' }),
        ];
        const seen = new Set([first]);
        for (const edit of edits) {
          await edit();
          await replanReminders(db, { now: at('2026-07-08T09:00:00Z') });
          seen.add(await hash());
        }
        // Every edit gave a hash of its own.
        expect(seen.size).toBe(edits.length + 1);
      });

      it('does not change when the worker activates the occurrence, but does when it is started', async () => {
        const { o } = await setup();
        await db.update(occurrence).set({ status: 'upcoming' }).where(eq(occurrence.id, o.id));
        await replanReminders(db, { now: NOW });
        const first = (await hashOf(o.id))?.reminderPlanHash;

        await db.update(occurrence).set({ status: 'active' }).where(eq(occurrence.id, o.id));
        await replanReminders(db, { now: NOW });
        expect((await hashOf(o.id))?.reminderPlanHash).toBe(first);

        await db.update(occurrence).set({ status: 'started' }).where(eq(occurrence.id, o.id));
        await replanReminders(db, { now: NOW });
        expect((await hashOf(o.id))?.reminderPlanHash).not.toBe(first);
      });

      it('lets an idle tick write nothing, occurrences included', async () => {
        const { o } = await setup();
        await replanReminders(db, { now: NOW });
        const before = await hashOf(o.id);

        await replanReminders(db, { now: at('2026-07-06T09:01:00Z') });

        expect(await hashOf(o.id)).toEqual(before);
      });

      it('leaves rows alone while the inputs are unchanged, adding no missing row but overdue ones', async () => {
        await setup();
        await replanReminders(db, { now: NOW });
        // Rows out of step with the plan: one cancelled, one moved, one gone.
        await db.update(reminder).set({ status: 'cancelled' }).where(eq(reminder.key, 'heads_up'));
        const moved = at('2026-07-17T10:00:00Z');
        await db
          .update(reminder)
          .set({ fireAt: moved })
          .where(eq(reminder.key, 'nudge:2026-07-15'));
        await db.delete(reminder).where(eq(reminder.key, 'due'));

        const result = await replanReminders(db, { now: NOW });

        expect(result).toEqual({ occurrences: 1, planned: 0, cancelled: 0, failures: [] });
        const byKey = Object.fromEntries((await reminders()).map((r) => [r.key, r]));
        expect(byKey['heads_up']?.status).toBe('cancelled');
        expect(byKey['nudge:2026-07-15']).toMatchObject({ status: 'planned', fireAt: moved });
        // A missing row is only restored with a full re-plan, except for overdue ones.
        expect(byKey['due']).toBeUndefined();
      });

      it('rolls the overdue horizon forward without disturbing the other reminders', async () => {
        await setup({ reminderProfile: 'persistent' });
        await replanReminders(db, { now: NOW });
        const before = await reminders();
        expect(before.some((r) => r.kind === 'overdue')).toBe(false);

        const result = await replanReminders(db, { now: at('2026-07-12T09:00:00Z') });

        // Overdue reminders from 21 to 25 July (19:00 BST, within 14 days of 12 July).
        expect(result).toEqual({ occurrences: 1, planned: 5, cancelled: 0, failures: [] });
        const after = await reminders();
        expect(after.filter((r) => r.kind === 'overdue')).toHaveLength(5);
        expect(after.filter((r) => r.kind !== 'overdue')).toEqual(before);
      });

      it('adds only overdue reminders while the inputs are unchanged', async () => {
        await setup({ reminderProfile: 'persistent' });
        await replanReminders(db, { now: NOW });
        // A nudge the held plan had deduplicated away looks like this: no row, still wanted.
        await db.delete(reminder).where(eq(reminder.key, 'nudge:2026-07-15'));

        const result = await replanReminders(db, { now: at('2026-07-12T09:00:00Z') });

        expect(result).toMatchObject({ planned: 5, cancelled: 0 });
        const rows = await reminders();
        expect(rows.filter((r) => r.kind === 'overdue')).toHaveLength(5);
        expect(rows.map((r) => r.key)).not.toContain('nudge:2026-07-15');
      });

      it('does not cancel a planned row the plan no longer lists, while the inputs are unchanged', async () => {
        await setup();
        await replanReminders(db, { now: NOW });

        // After the heads-up time the planner no longer lists it, but it is still planned.
        const result = await replanReminders(db, { now: DUE_AFTER_HEADS_UP });

        // Only the overdue horizon moved forward (two reminders now in reach).
        expect(result).toMatchObject({ planned: 2, cancelled: 0 });
        expect((await planned()).map((r) => r.key)).toContain('heads_up');
      });
    });

    it('stores the milestone and overdue details of a reminder', async () => {
      const { t, o } = await setup({ reminderProfile: 'persistent' });
      const [m] = await db
        .insert(taskMilestone)
        .values({ taskId: t.id, title: 'Get quotes', offsetDaysBeforeDue: 3, position: 0 })
        .returning();
      await replanReminders(db, { now: NOW });
      expect((await reminders()).find((r) => r.kind === 'milestone')).toMatchObject({
        key: `milestone:${m?.id}`,
        data: { milestoneId: m?.id, milestoneTitle: 'Get quotes' },
      });

      // Two days after the due date the next overdue reminder is the persistent daily one.
      await replanReminders(db, { now: at('2026-07-22T09:00:00Z') });
      const overdue = (await reminders()).filter((r) => r.kind === 'overdue');
      expect(overdue.map((r) => r.data)).toContainEqual({ overdueDays: 3 });
      expect(overdue.every((r) => r.occurrenceId === o.id)).toBe(true);
    });

    it('moves reminders when the occurrence is snoozed, and back when it is not', async () => {
      const { o } = await setup();
      await replanReminders(db, { now: NOW });
      const snoozedUntil = at('2026-07-12T10:00:00Z');

      await db.update(occurrence).set({ snoozedUntil }).where(eq(occurrence.id, o.id));
      const result = await replanReminders(db, { now: NOW });

      // Only the heads-up (10 July) is held by a snooze to 12 July.
      expect(result).toMatchObject({ planned: 1, cancelled: 0 });
      const rows = await planned();
      expect(rows.find((r) => r.key === 'heads_up')?.fireAt).toEqual(snoozedUntil);
      expect(keys(rows)).toEqual([...PLAN_KEYS].sort());

      await db.update(occurrence).set({ snoozedUntil: null }).where(eq(occurrence.id, o.id));
      await replanReminders(db, { now: NOW });
      expect((await planned()).find((r) => r.key === 'heads_up')?.fireAt).toEqual(HEADS_UP_AT);
    });

    it.each(['done', 'skipped'] as const)(
      'cancels the reminders of a %s occurrence',
      async (status) => {
        const { o } = await setup();
        await replanReminders(db, { now: NOW });

        await db.update(occurrence).set({ status }).where(eq(occurrence.id, o.id));
        const result = await replanReminders(db, { now: NOW });

        expect(result).toEqual({ occurrences: 0, planned: 0, cancelled: 5, failures: [] });
        expect((await reminders()).every((r) => r.status === 'cancelled')).toBe(true);
        // Nothing is revived by the next run.
        expect(await replanReminders(db, { now: NOW })).toMatchObject({ planned: 0, cancelled: 0 });
      },
    );

    it('cancels the reminders of an archived task', async () => {
      const { t } = await setup();
      await replanReminders(db, { now: NOW });

      await db.update(task).set({ archivedAt: NOW }).where(eq(task.id, t.id));
      const result = await replanReminders(db, { now: NOW });

      expect(result).toEqual({ occurrences: 0, planned: 0, cancelled: 5, failures: [] });
      expect((await reminders()).every((r) => r.status === 'cancelled')).toBe(true);
    });

    it('plans an unarchived task`s reminders again, overdue ones included', async () => {
      const { t, o } = await setup({ reminderProfile: 'persistent' });
      await db.update(occurrence).set({ status: 'started' }).where(eq(occurrence.id, o.id));
      const overdueNow = at('2026-07-22T09:00:00Z');
      await replanReminders(db, { now: overdueNow });
      const before = await planned();
      expect(before.some((r) => r.kind === 'overdue')).toBe(true);
      const [stamped] = await db.select().from(occurrence).where(eq(occurrence.id, o.id));

      await db.update(task).set({ archivedAt: overdueNow }).where(eq(task.id, t.id));
      const archived = await replanReminders(db, { now: overdueNow });
      expect(archived).toMatchObject({ cancelled: before.length });
      expect(await planned()).toEqual([]);
      const [hash] = await db.select().from(occurrence).where(eq(occurrence.id, o.id));
      expect(hash?.reminderPlanHash).toBeNull();
      expect(hash?.updatedAt).toEqual(stamped?.updatedAt);
      // Archived and idle: nothing more to write.
      const rows = await reminders();
      await replanReminders(db, { now: overdueNow });
      expect(await reminders()).toEqual(rows);

      await db.update(task).set({ archivedAt: null }).where(eq(task.id, t.id));
      await replanReminders(db, { now: overdueNow });

      const withoutUpdatedAt = (rows: { updatedAt: Date }[]) =>
        rows.map((r) => ({ ...r, updatedAt: null }));
      expect(withoutUpdatedAt(await planned())).toEqual(withoutUpdatedAt(before));
    });

    it('plans a reopened occurrence`s reminders again', async () => {
      const { o } = await setup();
      await replanReminders(db, { now: NOW });
      await db.update(occurrence).set({ status: 'done' }).where(eq(occurrence.id, o.id));
      await replanReminders(db, { now: NOW });
      expect(await planned()).toEqual([]);

      await db.update(occurrence).set({ status: 'active' }).where(eq(occurrence.id, o.id));
      await replanReminders(db, { now: NOW });

      expect(keys(await planned())).toEqual([...PLAN_KEYS].sort());
    });

    it('addresses the reminders to the new assignee after a reassignment', async () => {
      const { h, o } = await setup();
      const sam = await newMember(h.id, 'sam');
      await replanReminders(db, { now: NOW });

      await db.update(occurrence).set({ assigneeId: sam.id }).where(eq(occurrence.id, o.id));
      expect(await replanReminders(db, { now: NOW })).toMatchObject({ planned: 5, cancelled: 0 });
      expect((await planned()).every((r) => r.memberId === sam.id)).toBe(true);

      await db.update(occurrence).set({ assigneeId: null }).where(eq(occurrence.id, o.id));
      await replanReminders(db, { now: NOW });
      expect((await planned()).every((r) => r.memberId === null)).toBe(true);
    });

    it('holds reminders while the assignee is away', async () => {
      const { alex } = await setup();
      await replanReminders(db, { now: NOW });

      await db.update(member).set({ awayUntil: '2026-07-12' }).where(eq(member.id, alex.id));
      const result = await replanReminders(db, { now: NOW });

      // Back on 13 July: the heads-up waits for that day's evening slot (19:00 BST).
      expect(result).toMatchObject({ planned: 1, cancelled: 0 });
      expect((await planned()).find((r) => r.key === 'heads_up')?.fireAt).toEqual(
        at('2026-07-13T18:00:00Z'),
      );

      await db.update(member).set({ awayUntil: null }).where(eq(member.id, alex.id));
      await replanReminders(db, { now: NOW });
      expect((await planned()).find((r) => r.key === 'heads_up')?.fireAt).toEqual(HEADS_UP_AT);
    });

    it('stops reminding about a milestone once it is ticked off', async () => {
      const { t, o } = await setup();
      const [m] = await db
        .insert(taskMilestone)
        .values({ taskId: t.id, title: 'Get quotes', offsetDaysBeforeDue: 3, position: 0 })
        .returning();
      if (!m) throw new Error('insert failed');
      await replanReminders(db, { now: NOW });
      expect(keys(await planned())).toContain(`milestone:${m.id}`);

      await db
        .update(occurrence)
        .set({ milestoneProgress: { [m.id]: '2026-07-07T10:00:00Z' } })
        .where(eq(occurrence.id, o.id));
      const result = await replanReminders(db, { now: NOW });

      expect(result).toMatchObject({ planned: 0, cancelled: 1 });
      expect(keys(await planned())).toEqual([...PLAN_KEYS].sort());
    });

    it('adds the reminders of a changed task, and drops those that no longer apply', async () => {
      const { t } = await setup();
      await replanReminders(db, { now: NOW });

      await db.update(task).set({ leadTimeDays: null }).where(eq(task.id, t.id));
      expect(await replanReminders(db, { now: NOW })).toMatchObject({ planned: 0, cancelled: 4 });
      expect(keys(await planned())).toEqual(['due']);

      // Silent tasks get no reminders at all.
      await db.update(task).set({ reminderProfile: 'silent' }).where(eq(task.id, t.id));
      await replanReminders(db, { now: NOW });
      expect(await planned()).toEqual([]);

      // And the plan comes back when the profile does: cancelled rows are revived.
      await db
        .update(task)
        .set({ reminderProfile: 'standard', leadTimeDays: 10 })
        .where(eq(task.id, t.id));
      expect(await replanReminders(db, { now: NOW })).toMatchObject({ planned: 5, cancelled: 0 });
      expect(keys(await planned())).toEqual([...PLAN_KEYS].sort());
    });

    it('never touches a reminder that was already sent', async () => {
      const { t } = await setup();
      await replanReminders(db, { now: NOW });
      const [first] = await reminders();
      await db
        .update(reminder)
        .set({ status: 'sent', sentAt: HEADS_UP_AT })
        .where(eq(reminder.id, first?.id ?? ''));
      const sent = (await reminders()).find((r) => r.id === first?.id);

      // The planner wants the same key at a different time now; the sent row stays as it is.
      await db.update(task).set({ reminderSlot: 'morning' }).where(eq(task.id, t.id));
      const result = await replanReminders(db, { now: NOW });

      expect(result.planned).toBe(4);
      expect((await reminders()).find((r) => r.id === first?.id)).toEqual(sent);
      expect(await reminders()).toHaveLength(5);
    });

    it('plans every household`s occurrences and only open ones', async () => {
      await setup();
      const other = await setup();
      await newOccurrence(other.t.id, {
        dueDate: '2026-07-27',
        assigneeId: other.alex.id,
        status: 'done',
      });
      await newOccurrence(other.t.id, { dueDate: '2026-07-13', status: 'upcoming' });

      const result = await replanReminders(db, { now: NOW });

      expect(result.occurrences).toBe(3);
      expect(result.failures).toEqual([]);
      const done = await db.select().from(occurrence).where(eq(occurrence.status, 'done'));
      const rows = await reminders();
      expect(rows.some((r) => r.occurrenceId === done[0]?.id)).toBe(false);
    });

    it('reports an occurrence the planner rejects and plans the others', async () => {
      const broken = await newHousehold({ timezone: 'Not/AZone' });
      const brokenTask = await newTask(broken.id, { title: 'Broken' });
      const brokenOcc = await newOccurrence(brokenTask.id);
      const { o } = await setup();

      const result = await replanReminders(db, { now: NOW });

      expect(result).toMatchObject({ occurrences: 1, planned: 5, cancelled: 0 });
      expect(result.failures).toEqual([
        {
          occurrenceId: brokenOcc.id,
          taskId: brokenTask.id,
          code: expect.any(String),
          message: expect.any(String),
        },
      ]);
      expect((await reminders()).every((r) => r.occurrenceId === o.id)).toBe(true);
    });

    it('plans nothing for an undated occurrence', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, { dueDate: null, leadTimeDays: null });
      await newOccurrence(t.id, { dueDate: null });

      expect(await replanReminders(db, { now: NOW })).toMatchObject({ occurrences: 1, planned: 0 });
      expect(await reminders()).toEqual([]);
    });

    it('handles a timed due', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id, {
        dueDate: null,
        allDay: false,
        dueAt: at('2026-07-20T14:00:00Z'),
      });
      await newOccurrence(t.id, { dueDate: null, dueAt: at('2026-07-20T14:00:00Z') });

      await replanReminders(db, { now: NOW });

      // 14:00Z is 15:00 BST, before the evening slot, so the due reminder is the evening before.
      expect((await reminders()).find((r) => r.key === 'due')?.fireAt).toEqual(
        at('2026-07-19T18:00:00Z'),
      );
    });
  });

  describe('queueDueReminders', () => {
    const DUE_NOW = at('2026-07-10T18:00:30Z');

    it('queues a due reminder for its assignee and marks it sent', async () => {
      const { h, alex, t, o } = await setup();
      await replanReminders(db, { now: NOW });

      const result = await queueDueReminders(db, { now: DUE_NOW });

      expect(result).toEqual({ queued: 1, notifications: 1, cancelled: 0, failures: [] });
      const [rem] = await reminders();
      expect(rem).toMatchObject({ key: 'heads_up', status: 'sent', sentAt: DUE_NOW });
      const [n] = await notifications();
      expect(n).toMatchObject({
        householdId: h.id,
        memberId: alex.id,
        reminderId: rem?.id,
        channel: 'in_app',
        dedupeKey: `reminder:${rem?.id}:in_app:${alex.id}`,
        attempts: 0,
        sentAt: null,
        failedAt: null,
        readAt: null,
        payload: {
          type: 'reminder',
          kind: 'heads_up',
          taskId: t.id,
          occurrenceId: o.id,
          taskTitle: 'Car insurance',
          dueDate: '2026-07-20',
          dueAt: null,
          fireAt: HEADS_UP_AT.toISOString(),
          assigneeId: alex.id,
        },
      });
      expect(n?.dedupeKey).toBe(inAppDedupeKey(rem?.id ?? '', alex.id));
    });

    it('sends an unassigned reminder to every member of its household only', async () => {
      const h = await newHousehold();
      const [a, b] = [await newMember(h.id, 'a'), await newMember(h.id, 'b')];
      const t = await newTask(h.id);
      await newOccurrence(t.id);
      const other = await newHousehold();
      await newMember(other.id, 'stranger');
      await replanReminders(db, { now: NOW });

      const result = await queueDueReminders(db, { now: DUE_NOW });

      expect(result).toEqual({ queued: 1, notifications: 2, cancelled: 0, failures: [] });
      const rows = await notifications();
      expect(rows.map((n) => n.memberId).sort()).toEqual([a.id, b.id].sort());
      expect(rows.every((n) => n.householdId === h.id && n.payload.assigneeId === null)).toBe(true);
    });

    it('carries milestone and overdue details in the payload', async () => {
      const { t } = await setup({ reminderProfile: 'persistent' });
      await db
        .insert(taskMilestone)
        .values({ taskId: t.id, title: 'Get quotes', offsetDaysBeforeDue: 3, position: 0 });
      await replanReminders(db, { now: NOW });
      await queueDueReminders(db, { now: at('2026-07-17T18:30:00Z') });
      expect(
        (await notifications()).map((n) => n.payload).find((p) => p.kind === 'milestone'),
      ).toMatchObject({ milestoneTitle: 'Get quotes' });

      await replanReminders(db, { now: at('2026-07-21T09:00:00Z') });
      await queueDueReminders(db, { now: at('2026-07-22T18:30:00Z') });
      const overdue = (await notifications())
        .map((n) => n.payload)
        .find((p) => p.kind === 'overdue');
      expect(overdue).toMatchObject({ overdueDays: 2 });
    });

    it('queues each reminder once however often it runs', async () => {
      await setup();
      await replanReminders(db, { now: NOW });

      await queueDueReminders(db, { now: DUE_NOW });
      const again = await queueDueReminders(db, { now: DUE_NOW });
      const later = await queueDueReminders(db, { now: at('2026-07-10T19:00:00Z') });

      expect(again).toEqual({ queued: 0, notifications: 0, cancelled: 0, failures: [] });
      expect(later.queued).toBe(0);
      expect(await notifications()).toHaveLength(1);
    });

    it('leaves reminders that are not due yet', async () => {
      await setup();
      await replanReminders(db, { now: NOW });

      const result = await queueDueReminders(db, { now: at('2026-07-10T17:59:59Z') });

      expect(result).toEqual({ queued: 0, notifications: 0, cancelled: 0, failures: [] });
      expect((await planned()).length).toBe(5);
    });

    it('cancels, rather than sends, a reminder more than a day late', async () => {
      await setup();
      await replanReminders(db, { now: NOW });

      const late = new Date(HEADS_UP_AT.getTime() + MISSED_REMINDER_GRACE_MS + 1);
      const result = await queueDueReminders(db, { now: late });

      expect(result).toEqual({ queued: 0, notifications: 0, cancelled: 1, failures: [] });
      expect((await reminders()).find((r) => r.key === 'heads_up')?.status).toBe('cancelled');
      expect(await notifications()).toEqual([]);
    });

    it('still sends a reminder that is exactly a day late', async () => {
      await setup();
      await replanReminders(db, { now: NOW });

      const result = await queueDueReminders(db, {
        now: new Date(HEADS_UP_AT.getTime() + MISSED_REMINDER_GRACE_MS),
      });

      expect(result).toMatchObject({ queued: 1, cancelled: 0 });
    });

    it('queues what is due and cancels what is stale in the same run', async () => {
      await setup();
      await replanReminders(db, { now: NOW });

      // Three days on: the heads-up is stale, the 15 July nudge was due 14 hours ago.
      const result = await queueDueReminders(db, { now: at('2026-07-16T08:00:00Z') });

      expect(result).toMatchObject({ queued: 1, cancelled: 1 });
      const byKey = Object.fromEntries((await reminders()).map((r) => [r.key, r.status]));
      expect(byKey).toMatchObject({ heads_up: 'cancelled', 'nudge:2026-07-15': 'sent' });
    });

    it.each([
      ['done', { status: 'done' as const }],
      ['skipped', { status: 'skipped' as const }],
      ['snoozed', { snoozedUntil: at('2026-07-11T10:00:00Z') }],
    ])('does not queue the reminder of an occurrence that is %s', async (_name, change) => {
      const { o } = await setup();
      await replanReminders(db, { now: NOW });

      await db.update(occurrence).set(change).where(eq(occurrence.id, o.id));
      const result = await queueDueReminders(db, { now: DUE_NOW });

      expect(result).toEqual({ queued: 0, notifications: 0, cancelled: 0, failures: [] });
      expect(await notifications()).toEqual([]);
      expect((await reminders()).find((r) => r.key === 'heads_up')?.status).toBe('planned');
    });

    it('does not queue the reminder of an archived task', async () => {
      const { t } = await setup();
      await replanReminders(db, { now: NOW });

      await db.update(task).set({ archivedAt: DUE_NOW }).where(eq(task.id, t.id));

      expect((await queueDueReminders(db, { now: DUE_NOW })).queued).toBe(0);
      expect(await notifications()).toEqual([]);
    });

    it('does not send a reminder that fell due under a snooze; the re-plan cancels it', async () => {
      const { o } = await setup();
      await replanReminders(db, { now: NOW });
      await db
        .update(occurrence)
        .set({ snoozedUntil: at('2026-07-10T20:00:00Z') })
        .where(eq(occurrence.id, o.id));

      expect((await queueDueReminders(db, { now: DUE_NOW })).queued).toBe(0);
      // The planner never plans a reminder at or before now, so the snoozed one is not revived...
      await replanReminders(db, { now: DUE_NOW });
      expect((await reminders()).find((r) => r.key === 'heads_up')?.status).toBe('cancelled');
      // ...and nothing is sent when the snooze ends.
      expect((await queueDueReminders(db, { now: at('2026-07-10T20:00:10Z') })).queued).toBe(0);
      expect(await notifications()).toEqual([]);
      expect(keys(await planned())).not.toContain('heads_up');
      expect(keys(await planned())).toContain('due');
    });

    it('does not mind a reminder row for an occurrence without a due date', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id);
      const o = await newOccurrence(t.id, { dueDate: null });
      await db.insert(reminder).values({
        occurrenceId: o.id,
        key: 'due',
        kind: 'due',
        fireAt: NOW,
      });

      expect((await queueDueReminders(db, { now: DUE_NOW })).queued).toBe(0);
      // The re-plan cancels it, as it does for any reminder the planner does not want.
      await replanReminders(db, { now: DUE_NOW });
      expect((await reminders())[0]?.status).toBe('cancelled');
    });

    describe('a reminder made stale by an edit since the last tick', () => {
      // The heads-up (10 July, 18:00Z) is already past when the edit is noticed.
      const headsUp = async () => (await reminders()).find((r) => r.key === 'heads_up');

      async function expectHeldBack(edit: () => Promise<unknown>, expected: Date | 'cancelled') {
        await replanReminders(db, { now: NOW });
        await edit();

        const queued = await queueDueReminders(db, { now: DUE_NOW });

        expect(queued).toEqual({ queued: 0, notifications: 0, cancelled: 0, failures: [] });
        expect(await notifications()).toEqual([]);
        expect((await headsUp())?.status).toBe('planned');

        await replanReminders(db, { now: DUE_NOW });
        if (expected === 'cancelled') {
          // The planner never plans at or before now, so the missed reminder is dropped.
          expect((await headsUp())?.status).toBe('cancelled');
        } else {
          expect(await headsUp()).toMatchObject({ status: 'planned', fireAt: expected });
        }
        expect(await queueDueReminders(db, { now: DUE_NOW })).toMatchObject({ queued: 0 });
        expect(await notifications()).toEqual([]);
      }

      it('goes to the new assignee after a reassignment', async () => {
        const { h, alex, o } = await setup();
        const sam = await newMember(h.id, 'sam');
        await replanReminders(db, { now: NOW });
        await db.update(occurrence).set({ assigneeId: sam.id }).where(eq(occurrence.id, o.id));

        const result = await queueDueReminders(db, { now: DUE_NOW });

        // The reminder is still wanted at the same time; it is for sam now, not alex.
        expect(result).toMatchObject({ queued: 1, notifications: 1 });
        const rows = await notifications();
        expect(rows.map((n) => n.memberId)).toEqual([sam.id]);
        expect(rows[0]?.payload).toMatchObject({ kind: 'heads_up', assigneeId: sam.id });
        expect(rows.some((n) => n.memberId === alex.id)).toBe(false);
        expect((await headsUp())?.status).toBe('sent');

        // The re-plan addresses the rest to sam, and the sent heads-up is left alone.
        await replanReminders(db, { now: DUE_NOW });
        expect(keys(await planned())).not.toContain('heads_up');
        expect((await planned()).every((r) => r.memberId === sam.id)).toBe(true);
      });

      it('is not sent while the assignee is away', async () => {
        const { alex } = await setup();
        await expectHeldBack(
          () => db.update(member).set({ awayUntil: '2026-07-12' }).where(eq(member.id, alex.id)),
          'cancelled',
        );

        // The hold only moves reminders still to come, so the missed heads-up is dropped and
        // the later ones are untouched.
        expect(keys(await planned())).not.toContain('heads_up');
        expect(keys(await planned())).toContain('nudge:2026-07-15');
      });

      it('is not sent after a snooze that ended since it fell due', async () => {
        const { o } = await setup();
        // Snoozed until 18:00:20, so by DUE_NOW (18:00:30) the snooze is over, yet it held the
        // reminder (due 18:00:00) back.
        await expectHeldBack(
          () =>
            db
              .update(occurrence)
              .set({ snoozedUntil: at('2026-07-10T18:00:20Z') })
              .where(eq(occurrence.id, o.id)),
          'cancelled',
        );
      });

      it('is not sent after the lead time changed; it moves to the new time', async () => {
        const { t } = await setup();
        await expectHeldBack(
          () => db.update(task).set({ leadTimeDays: 5 }).where(eq(task.id, t.id)),
          at('2026-07-15T18:00:00Z'),
        );
      });

      it('is not sent after the reminder slot changed; it moves to the new time', async () => {
        const { t } = await setup();
        await expectHeldBack(
          () => db.update(task).set({ reminderSlot: 'morning' }).where(eq(task.id, t.id)),
          // 07:00 BST is already past at DUE_NOW, so the planner drops it.
          'cancelled',
        );
      });

      it('is not sent after the due date moved', async () => {
        const { o } = await setup();
        await expectHeldBack(
          () => db.update(occurrence).set({ dueDate: '2026-07-30' }).where(eq(occurrence.id, o.id)),
          // 10 days before 30 July is 20 July.
          at('2026-07-20T18:00:00Z'),
        );
      });

      it('is not sent for a milestone that was ticked off', async () => {
        const { t, o } = await setup({ reminderProfile: 'persistent' });
        const [m] = await db
          .insert(taskMilestone)
          .values({ taskId: t.id, title: 'Get quotes', offsetDaysBeforeDue: 3, position: 0 })
          .returning();
        if (!m) throw new Error('insert failed');
        await replanReminders(db, { now: NOW });
        await db
          .update(occurrence)
          .set({ milestoneProgress: { [m.id]: true } })
          .where(eq(occurrence.id, o.id));

        // 17 July 18:30Z: the milestone (17 July 18:00Z) is due; so is nothing fresh besides it.
        await queueDueReminders(db, { now: at('2026-07-17T18:30:00Z') });

        const rows = await notifications();
        expect(rows.map((n) => n.payload.kind)).not.toContain('milestone');
        expect((await reminders()).find((r) => r.key === `milestone:${m.id}`)?.status).toBe(
          'planned',
        );
        await replanReminders(db, { now: at('2026-07-17T18:30:00Z') });
        expect((await reminders()).find((r) => r.key === `milestone:${m.id}`)?.status).toBe(
          'cancelled',
        );
      });

      it('still sends the ones that are unchanged while holding back the stale one', async () => {
        const { h, alex } = await setup();
        const sam = await newMember(h.id, 'sam');
        // A second task due the same day, assigned to sam, whose reminder is still right.
        const mot = await newTask(h.id, { title: 'MOT' });
        const motOcc = await newOccurrence(mot.id, { assigneeId: sam.id });
        await replanReminders(db, { now: NOW });
        await db.update(member).set({ awayUntil: '2026-07-12' }).where(eq(member.id, alex.id));

        const result = await queueDueReminders(db, { now: DUE_NOW });

        expect(result).toMatchObject({ queued: 1, notifications: 1 });
        const [n] = await notifications();
        expect(n).toMatchObject({ memberId: sam.id });
        expect(n?.payload).toMatchObject({ occurrenceId: motOcc.id, taskTitle: 'MOT' });
      });

      it('is left alone, and reported, when the planner rejects its occurrence', async () => {
        const broken = await newHousehold({ timezone: 'Not/AZone' });
        const brokenTask = await newTask(broken.id, { title: 'Broken' });
        const brokenOcc = await newOccurrence(brokenTask.id);
        await db.insert(reminder).values({
          occurrenceId: brokenOcc.id,
          key: 'heads_up',
          kind: 'heads_up',
          fireAt: HEADS_UP_AT,
        });
        const { o } = await setup();
        await replanReminders(db, { now: NOW });

        const result = await queueDueReminders(db, { now: DUE_NOW });

        // The healthy occurrence is still served; the broken one is reported once and kept.
        expect(result).toMatchObject({ queued: 1, notifications: 1 });
        expect(result.failures).toEqual([
          {
            occurrenceId: brokenOcc.id,
            taskId: brokenTask.id,
            code: expect.any(String),
            message: expect.any(String),
          },
        ]);
        expect((await notifications())[0]?.payload.occurrenceId).toBe(o.id);
        expect((await reminders()).find((r) => r.occurrenceId === brokenOcc.id)?.status).toBe(
          'planned',
        );
      });
    });

    describe('recipients', () => {
      it('goes to the whole household when the assignee was deleted, not to a stale member', async () => {
        const { h, alex } = await setup();
        const sam = await newMember(h.id, 'sam');
        await replanReminders(db, { now: NOW });

        // Deleting the member sets occurrence.assignee_id and reminder.member_id to null, which
        // is an unassigned occurrence, and those are addressed to the whole household.
        await db.delete(member).where(eq(member.id, alex.id));
        const [occ] = await db.select().from(occurrence);
        expect(occ?.assigneeId).toBeNull();
        expect((await planned()).every((r) => r.memberId === null)).toBe(true);

        const result = await queueDueReminders(db, { now: DUE_NOW });

        expect(result).toMatchObject({ queued: 1, notifications: 1 });
        const rows = await notifications();
        expect(rows.map((n) => n.memberId)).toEqual([sam.id]);
        expect(rows[0]?.payload.assigneeId).toBeNull();
      });

      it('goes to the assignee only, even if the row says household-wide', async () => {
        const { h, alex } = await setup();
        await newMember(h.id, 'sam');
        await replanReminders(db, { now: NOW });
        // A row out of step with its occurrence (it should be for alex). Nothing the planner
        // reads changed, so the row is queued as it stands, to the occurrence's assignee.
        await db.update(reminder).set({ memberId: null });

        const result = await queueDueReminders(db, { now: DUE_NOW });

        expect(result).toMatchObject({ queued: 1, notifications: 1 });
        expect((await notifications()).map((n) => n.memberId)).toEqual([alex.id]);
      });
    });

    describe('trusting the persisted row', () => {
      it('queues a due row as it stands when the plan inputs are unchanged', async () => {
        await setup();
        await replanReminders(db, { now: NOW });
        // The row was moved on purpose (as a hold would); the planner would not list it here.
        const moved = at('2026-07-10T12:00:00Z');
        await db.update(reminder).set({ fireAt: moved }).where(eq(reminder.key, 'heads_up'));

        const result = await queueDueReminders(db, { now: DUE_NOW });

        expect(result).toMatchObject({ queued: 1, notifications: 1 });
        expect((await notifications())[0]?.payload).toMatchObject({
          fireAt: moved.toISOString(),
        });
      });

      it('checks it against the planner once the plan inputs changed', async () => {
        const { t } = await setup();
        await replanReminders(db, { now: NOW });
        const moved = at('2026-07-10T12:00:00Z');
        await db.update(reminder).set({ fireAt: moved }).where(eq(reminder.key, 'heads_up'));
        // A lead time of 9 days puts the heads-up on 11 July, so the moved row is not wanted.
        await db.update(task).set({ leadTimeDays: 9 }).where(eq(task.id, t.id));

        const result = await queueDueReminders(db, { now: DUE_NOW });

        expect(result).toMatchObject({ queued: 0, notifications: 0 });
        expect((await reminders()).find((r) => r.key === 'heads_up')?.status).toBe('planned');
      });
    });

    it('queues nothing for a household without members', async () => {
      const h = await newHousehold();
      const t = await newTask(h.id);
      await newOccurrence(t.id);
      await replanReminders(db, { now: NOW });

      const result = await queueDueReminders(db, { now: DUE_NOW });

      expect(result).toEqual({ queued: 1, notifications: 0, cancelled: 0, failures: [] });
    });

    it('re-queues nothing after a rollback, and queues everything once afterwards', async () => {
      const { h, alex } = await setup();
      const sam = await newMember(h.id, 'sam');
      // A second task due the same day, so two reminders are due at once.
      const mot = await newTask(h.id, { title: 'MOT' });
      await newOccurrence(mot.id, { assigneeId: alex.id });
      await replanReminders(db, { now: NOW });
      const now = DUE_NOW;

      // A crash mid-run: the queue ran inside the transaction, then the process died.
      await expect(
        db.transaction(async (tx) => {
          const queued = await queueDueReminders(tx, { now });
          expect(queued.queued).toBeGreaterThan(0);
          throw new Error('worker killed');
        }),
      ).rejects.toThrow('worker killed');
      expect(await notifications()).toEqual([]);
      expect((await planned()).length).toBe(10);

      // The restarted worker queues each due reminder exactly once, for the assignee only.
      const result = await queueDueReminders(db, { now });
      expect(result.queued).toBe(2);
      const rows = await notifications();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((n) => n.dedupeKey)).size).toBe(2);
      expect(rows.every((n) => n.memberId === alex.id && n.memberId !== sam.id)).toBe(true);
      expect(await queueDueReminders(db, { now })).toMatchObject({ queued: 0, notifications: 0 });
    });

    it('queues each reminder once when callers race', async () => {
      const h = await newHousehold();
      await Promise.all(['a', 'b', 'c'].map((u) => newMember(h.id, u)));
      const t = await newTask(h.id);
      await newOccurrence(t.id);
      const mot = await newTask(h.id, { title: 'MOT' });
      await newOccurrence(mot.id);
      await replanReminders(db, { now: NOW });
      const now = DUE_NOW;

      const results = await Promise.all(
        [1, 2, 3, 4].map(() => db.transaction((tx) => queueDueReminders(tx, { now }))),
      );

      // Two due reminders, three recipients each.
      expect(results.reduce((sum, r) => sum + r.queued, 0)).toBe(2);
      expect(results.reduce((sum, r) => sum + r.notifications, 0)).toBe(6);
      expect(await notifications()).toHaveLength(6);
      const sent = await db
        .select()
        .from(reminder)
        .where(and(eq(reminder.status, 'sent')));
      expect(sent).toHaveLength(2);
    });
  });

  describe('a hold that outlasts the condition behind it', () => {
    // What the worker does each tick: queue what is due, then re-plan.
    async function tick(now: Date) {
      const queued = await queueDueReminders(db, { now });
      const replanned = await replanReminders(db, { now });
      return { queued, replanned };
    }
    const headsUp = async () => (await reminders()).find((r) => r.key === 'heads_up');

    it('sends a heads-up held to the day after the assignee`s away date when that day comes', async () => {
      const { alex } = await setup();
      await db.update(member).set({ awayUntil: '2026-07-12' }).where(eq(member.id, alex.id));
      // Away until 12 July: the heads-up (10 July) waits for the evening slot on 13 July.
      const held = at('2026-07-13T18:00:00Z');

      await tick(NOW);
      expect(await headsUp()).toMatchObject({ status: 'planned', fireAt: held });
      await tick(at('2026-07-12T12:00:00Z'));
      // On 13 July alex is no longer away, so the planner alone would not know of the hold.
      await tick(at('2026-07-13T00:30:00Z'));
      await tick(at('2026-07-13T12:00:00Z'));
      expect(await headsUp()).toMatchObject({ status: 'planned', fireAt: held });
      expect(await notifications()).toEqual([]);

      const result = await tick(at('2026-07-13T18:00:30Z'));

      expect(result.queued).toMatchObject({ queued: 1, notifications: 1 });
      expect(await headsUp()).toMatchObject({ status: 'sent' });
      expect((await notifications()).map((n) => n.payload)).toMatchObject([
        { kind: 'heads_up', fireAt: held.toISOString() },
      ]);
    });

    it('queues the held reminder without a re-plan in between', async () => {
      const { alex } = await setup();
      await db.update(member).set({ awayUntil: '2026-07-12' }).where(eq(member.id, alex.id));
      await replanReminders(db, { now: NOW });

      // The queue-time check must not drop it just because the away period is over.
      const result = await queueDueReminders(db, { now: at('2026-07-13T18:00:30Z') });

      expect(result).toMatchObject({ queued: 1, notifications: 1 });
    });

    describe('a snooze into quiet hours', () => {
      // The task reminds at 19:00; both household slots are inside the quiet hours (22:00 to
      // 07:30), so a time pushed out of them lands on 07:30.
      async function setupQuiet() {
        const fixture = await setup({ reminderSlot: 'custom_time', reminderCustomTime: '19:00' });
        await db.update(household).set({
          morningSlot: '07:00',
          eveningSlot: '23:00',
          quietHoursStart: '22:00',
          quietHoursEnd: '07:30',
        });
        // Snoozed until 22:30 BST on 10 July: held to 07:30 BST the next morning.
        await db
          .update(occurrence)
          .set({ snoozedUntil: at('2026-07-10T21:30:00Z') })
          .where(eq(occurrence.id, fixture.o.id));
        return fixture;
      }
      const held = at('2026-07-11T06:30:00Z');

      it('is sent at the end of the quiet hours', async () => {
        await setupQuiet();

        await tick(NOW);
        expect(await headsUp()).toMatchObject({ status: 'planned', fireAt: held });
        // The snooze is over, the held time is not.
        await tick(at('2026-07-10T21:45:00Z'));
        await tick(at('2026-07-11T03:00:00Z'));
        expect(await headsUp()).toMatchObject({ status: 'planned', fireAt: held });
        expect(await notifications()).toEqual([]);

        const result = await tick(at('2026-07-11T06:30:30Z'));

        expect(result.queued).toMatchObject({ queued: 1, notifications: 1 });
        expect((await notifications())[0]?.payload).toMatchObject({
          kind: 'heads_up',
          fireAt: held.toISOString(),
        });
      });

      it('is queued without a re-plan in between', async () => {
        await setupQuiet();
        await replanReminders(db, { now: NOW });

        const result = await queueDueReminders(db, { now: at('2026-07-11T06:30:30Z') });

        expect(result).toMatchObject({ queued: 1, notifications: 1 });
      });
    });
  });

  describe('completedMilestoneIds', () => {
    it('lists the milestones with a truthy value', () => {
      expect(
        completedMilestoneIds({ a: true, b: false, c: '2026-07-01T00:00:00Z', d: null, e: 0 }),
      ).toEqual(['a', 'c']);
      expect(completedMilestoneIds({})).toEqual([]);
    });
  });
});
