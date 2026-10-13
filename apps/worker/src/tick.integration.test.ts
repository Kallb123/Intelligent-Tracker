import {
  createDb,
  household,
  member,
  notification,
  occurrence,
  queueDueReminders,
  reminder,
  runMigrations,
  serviceHeartbeat,
  task,
  taskAssignee,
  taskMilestone,
  type DbHandle,
} from '@tracker/db';
import { createTestDatabase, type TestDatabase } from '@tracker/db/test-db';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TICK_LOCK_KEY, runTick } from './tick.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

const at = (iso: string): Date => new Date(iso);

describe.skipIf(!adminUrl)('worker tick (integration)', () => {
  let testDb: TestDatabase;
  let handle: DbHandle;
  const logger = { warn: vi.fn() };

  beforeAll(async () => {
    testDb = await createTestDatabase(adminUrl as string);
    await runMigrations({ databaseUrl: testDb.url });
    handle = createDb(testDb.url);
  });

  afterAll(async () => {
    await handle?.close();
    await testDb?.drop();
  });

  // Every test starts from an empty database (the household delete cascades to everything).
  beforeEach(async () => {
    logger.warn.mockClear();
    await handle.db.delete(household);
    await handle.db.delete(serviceHeartbeat);
  });

  async function newTask(values: Partial<typeof task.$inferInsert> = {}) {
    const [h] = await handle.db.insert(household).values({ name: 'Test' }).returning();
    if (!h) throw new Error('insert failed');
    const [t] = await handle.db
      .insert(task)
      .values({
        householdId: h.id,
        title: 'Bins',
        scheduleKind: 'fixed',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        dueDate: '2026-07-06',
        ...values,
      })
      .returning();
    if (!t) throw new Error('insert failed');
    return t;
  }

  const occurrences = () => handle.db.select().from(occurrence);

  it('materialises occurrences and activates the ones that are due', async () => {
    await newTask();

    const result = await runTick(handle.db, { now: at('2026-07-06T09:00:00Z'), logger });

    expect(result).toMatchObject({
      skipped: false,
      tasks: 1,
      inserted: 13,
      activated: 0,
      failures: [],
      queued: 0,
      cancelled: 0,
      planFailures: [],
      delivered: 0,
      pruned: 0,
    });
    const rows = await occurrences();
    expect(rows).toHaveLength(13);
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
  });

  it('is idempotent: a second tick inserts nothing and changes no rows', async () => {
    await newTask();
    const now = at('2026-07-06T09:00:00Z');
    await runTick(handle.db, { now, logger });
    const before = await occurrences();

    const again = await runTick(handle.db, { now, logger });

    expect(again).toEqual({
      skipped: false,
      tasks: 1,
      inserted: 0,
      activated: 0,
      failures: [],
      queued: 0,
      planned: 0,
      cancelled: 0,
      planFailures: [],
      delivered: 0,
      pruned: 0,
    });
    expect(await occurrences()).toEqual(before);
  });

  it('rotates new occurrences between the assignees, and a repeat tick leaves them alone', async () => {
    const t = await newTask({ assignmentMode: 'rotation' });
    const members = await handle.db
      .insert(member)
      .values(['a', 'b', 'c'].map((u) => ({ householdId: t.householdId, name: u, username: u })))
      .returning();
    await handle.db
      .insert(taskAssignee)
      .values(members.map((m, position) => ({ taskId: t.id, memberId: m.id, position })));
    const now = at('2026-07-06T09:00:00Z');

    await runTick(handle.db, { now, logger });
    const rows = () => handle.db.select().from(occurrence).orderBy(asc(occurrence.dueDate));
    const before = await rows();
    // A, B, C, A, B, ...
    expect(before.slice(0, 4).map((r) => r.assigneeId)).toEqual(
      [0, 1, 2, 0].map((i) => members[i]?.id),
    );

    // A week on, the new horizon day continues the rotation without touching the others.
    await runTick(handle.db, { now: at('2026-07-13T09:00:00Z'), logger });
    const after = await rows();
    expect(after).toHaveLength(14);
    expect(after.slice(0, 13).map((r) => r.assigneeId)).toEqual(before.map((r) => r.assigneeId));
    expect(after[13]?.assigneeId).toBe(members[1]?.id);

    const again = await runTick(handle.db, { now: at('2026-07-13T09:00:00Z'), logger });
    expect(again).toMatchObject({ inserted: 0 });
    expect(await rows()).toEqual(after);
  });

  it('activates upcoming occurrences once their day arrives', async () => {
    await newTask();
    await runTick(handle.db, { now: at('2026-07-06T09:00:00Z'), logger });

    // A week later: the 13 July occurrence is due, and the horizon has moved on by one.
    const result = await runTick(handle.db, { now: at('2026-07-13T09:00:00Z'), logger });

    expect(result).toMatchObject({ skipped: false, inserted: 1, activated: 1 });
    const open = await handle.db.select().from(occurrence).where(eq(occurrence.status, 'active'));
    expect(open.map((r) => r.dueDate).sort()).toEqual(['2026-07-06', '2026-07-13']);
  });

  it('does not duplicate rows when two ticks run at once', async () => {
    await newTask();
    const now = at('2026-07-06T09:00:00Z');

    const results = await Promise.all([
      runTick(handle.db, { now, logger }),
      runTick(handle.db, { now, logger }),
    ]);

    // Either the second waited for nothing (skipped) or ran after the first (inserted 0).
    const inserted = results.reduce((sum, r) => sum + (r.skipped ? 0 : r.inserted), 0);
    expect(inserted).toBe(13);
    expect(await occurrences()).toHaveLength(13);
  });

  it('skips the tick while another worker holds the lock', async () => {
    await newTask();
    const now = at('2026-07-06T09:00:00Z');

    // Hold the lock from a separate session, as another worker mid-tick would.
    let release: () => void = () => {};
    let held: () => void = () => {};
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = handle.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${TICK_LOCK_KEY}::bigint)`;
      held();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await holding;
    try {
      expect(await runTick(handle.db, { now, logger })).toEqual({ skipped: true });
      expect(await occurrences()).toHaveLength(0);
    } finally {
      release();
      await holder;
    }

    // Once the lock is free the next tick does the work.
    expect(await runTick(handle.db, { now, logger })).toMatchObject({ skipped: false });
    expect(await occurrences()).toHaveLength(13);
  });

  it('logs a task that cannot be materialised and still handles the others', async () => {
    const broken = await newTask({ title: 'Broken', rrule: 'NOT-AN-RRULE' });
    await newTask({ title: 'Fine' });

    const result = await runTick(handle.db, { now: at('2026-07-06T09:00:00Z'), logger });

    expect(result).toMatchObject({ skipped: false, tasks: 2, inserted: 13 });
    if (result.skipped) throw new Error('unreachable');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ taskId: broken.id });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: broken.id }),
      'could not materialise task',
    );
  });

  it('releases the lock after a tick', async () => {
    await newTask();
    await runTick(handle.db, { now: at('2026-07-06T09:00:00Z'), logger });

    const rows = await handle.sql`
      select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${TICK_LOCK_KEY}`;
    expect(rows[0]?.['n']).toBe(0);
  });

  describe('reminders', () => {
    // A one-off task due on 20 July with a 10 day lead time: at NOW (6 July) it plans a heads-up
    // on 10 July and nudges on 15, 18 and 19 July, then the due reminder on 20 July, all at the
    // 19:00 evening slot (18:00Z in BST).
    const NOW = at('2026-07-06T09:00:00Z');
    const HEADS_UP_AT = at('2026-07-10T18:00:00Z');
    const HEADS_UP_TICK = at('2026-07-10T18:00:30Z');
    const KEYS = ['due', 'heads_up', 'nudge:2026-07-15', 'nudge:2026-07-18', 'nudge:2026-07-19'];

    let users = 0;
    async function newMember(householdId: string, awayUntil?: string) {
      users += 1;
      const [m] = await handle.db
        .insert(member)
        .values({
          householdId,
          name: `m${users}`,
          username: `m${users}`,
          ...(awayUntil ? { awayUntil } : {}),
        })
        .returning();
      if (!m) throw new Error('insert failed');
      return m;
    }

    /** A household with a one-off task due on 20 July, assigned to `assignees` (or no one). */
    async function setup(options: { assignees?: number; members?: number } = {}) {
      const t = await newTask({
        scheduleKind: 'once',
        rrule: null,
        dueDate: '2026-07-20',
        leadTimeDays: 10,
        assignmentMode: options.assignees ? 'fixed' : 'any',
      });
      const people = [];
      for (let i = 0; i < Math.max(options.assignees ?? 0, options.members ?? 0); i += 1) {
        people.push(await newMember(t.householdId));
      }
      const assignees = people.slice(0, options.assignees ?? 0);
      if (assignees.length > 0) {
        await handle.db
          .insert(taskAssignee)
          .values(assignees.map((m, position) => ({ taskId: t.id, memberId: m.id, position })));
      }
      return { t, people };
    }

    const tick = (now: Date) => runTick(handle.db, { now, logger });
    const reminders = () =>
      handle.db.select().from(reminder).orderBy(asc(reminder.fireAt), asc(reminder.key));
    const notifications = () => handle.db.select().from(notification);
    const onlyOccurrence = async () => {
      const [o] = await occurrences();
      if (!o) throw new Error('no occurrence');
      return o;
    };
    const planned = async () => (await reminders()).filter((r) => r.status === 'planned');
    const keysOf = (rows: { key: string }[]) => rows.map((r) => r.key).sort();

    it('persists the planned reminders on the first tick', async () => {
      const { people } = await setup({ assignees: 1 });

      const result = await tick(NOW);

      expect(result).toMatchObject({ skipped: false, inserted: 1, planned: 5, planFailures: [] });
      const rows = await reminders();
      expect(keysOf(rows)).toEqual(KEYS);
      expect(rows.every((r) => r.status === 'planned' && r.memberId === people[0]?.id)).toBe(true);
      expect(rows[0]).toMatchObject({ key: 'heads_up', fireAt: HEADS_UP_AT });
      expect(await notifications()).toEqual([]);
    });

    it('writes nothing on an idle second tick', async () => {
      await setup({ assignees: 1 });
      await tick(NOW);
      const before = await reminders();

      const again = await tick(at('2026-07-06T09:01:00Z'));

      expect(again).toMatchObject({ queued: 0, planned: 0, cancelled: 0, delivered: 0 });
      expect(await reminders()).toEqual(before);
    });

    describe('re-plans on an edit', () => {
      it('snooze', async () => {
        await setup({ assignees: 1 });
        await tick(NOW);
        const o = await onlyOccurrence();

        await handle.db
          .update(occurrence)
          .set({ snoozedUntil: at('2026-07-12T10:00:00Z') })
          .where(eq(occurrence.id, o.id));
        const result = await tick(at('2026-07-06T09:01:00Z'));

        expect(result).toMatchObject({ planned: 1, cancelled: 0 });
        expect((await planned()).find((r) => r.key === 'heads_up')?.fireAt).toEqual(
          at('2026-07-12T10:00:00Z'),
        );
      });

      it.each(['done', 'skipped'] as const)('%s', async (status) => {
        await setup({ assignees: 1 });
        await tick(NOW);
        const o = await onlyOccurrence();

        await handle.db.update(occurrence).set({ status }).where(eq(occurrence.id, o.id));
        const result = await tick(at('2026-07-06T09:01:00Z'));

        expect(result).toMatchObject({ planned: 0, cancelled: 5 });
        expect(await planned()).toEqual([]);
      });

      it('reassignment', async () => {
        const { people } = await setup({ assignees: 1, members: 2 });
        await tick(NOW);
        const o = await onlyOccurrence();

        await handle.db
          .update(occurrence)
          .set({ assigneeId: people[1]?.id ?? null })
          .where(eq(occurrence.id, o.id));
        const result = await tick(at('2026-07-06T09:01:00Z'));

        expect(result).toMatchObject({ planned: 5, cancelled: 0 });
        expect((await planned()).every((r) => r.memberId === people[1]?.id)).toBe(true);
      });

      it('assignee going away', async () => {
        const { people } = await setup({ assignees: 1 });
        await tick(NOW);

        await handle.db
          .update(member)
          .set({ awayUntil: '2026-07-12' })
          .where(eq(member.id, people[0]?.id ?? ''));
        const result = await tick(at('2026-07-06T09:01:00Z'));

        expect(result).toMatchObject({ planned: 1, cancelled: 0 });
        expect((await planned()).find((r) => r.key === 'heads_up')?.fireAt).toEqual(
          at('2026-07-13T18:00:00Z'),
        );
      });

      it('archiving the task', async () => {
        const { t } = await setup({ assignees: 1 });
        await tick(NOW);

        await handle.db
          .update(task)
          .set({ archivedAt: at('2026-07-06T09:00:30Z') })
          .where(eq(task.id, t.id));
        const result = await tick(at('2026-07-06T09:01:00Z'));

        expect(result).toMatchObject({ planned: 0, cancelled: 5 });
        expect(await planned()).toEqual([]);
      });

      it('ticking off a milestone', async () => {
        const { t } = await setup({ assignees: 1 });
        const [m] = await handle.db
          .insert(taskMilestone)
          .values({ taskId: t.id, title: 'Get quotes', offsetDaysBeforeDue: 3, position: 0 })
          .returning();
        await tick(NOW);
        expect(keysOf(await planned())).toContain(`milestone:${m?.id}`);
        const o = await onlyOccurrence();

        await handle.db
          .update(occurrence)
          .set({ milestoneProgress: { [m?.id ?? '']: true } })
          .where(eq(occurrence.id, o.id));
        const result = await tick(at('2026-07-06T09:01:00Z'));

        expect(result).toMatchObject({ planned: 0, cancelled: 1 });
        expect(keysOf(await planned())).toEqual(KEYS);
      });
    });

    it('queues a due reminder once for the assignee and delivers it in-app', async () => {
      const { t, people } = await setup({ assignees: 1, members: 2 });
      await tick(NOW);
      const o = await onlyOccurrence();

      const result = await tick(HEADS_UP_TICK);

      expect(result).toMatchObject({ queued: 1, delivered: 1, cancelled: 0 });
      const rows = await notifications();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        memberId: people[0]?.id,
        channel: 'in_app',
        sentAt: HEADS_UP_TICK,
        readAt: null,
        payload: {
          type: 'reminder',
          kind: 'heads_up',
          taskId: t.id,
          occurrenceId: o.id,
          taskTitle: 'Bins',
          dueDate: '2026-07-20',
          dueAt: null,
          fireAt: HEADS_UP_AT.toISOString(),
          assigneeId: people[0]?.id,
        },
      });
      expect((await reminders()).find((r) => r.key === 'heads_up')).toMatchObject({
        status: 'sent',
        sentAt: HEADS_UP_TICK,
      });

      // Ticking again, now or later, queues and delivers nothing more.
      expect(await tick(HEADS_UP_TICK)).toMatchObject({ queued: 0, delivered: 0 });
      expect(await tick(at('2026-07-10T18:05:00Z'))).toMatchObject({ queued: 0, delivered: 0 });
      expect(await notifications()).toHaveLength(1);
    });

    it('sends a reminder with no assignee to every member of the household', async () => {
      const { people } = await setup({ members: 3 });
      // Another household with the same kind of task: its member must not get Bins reminders.
      const other = await newTask({
        title: 'Other',
        scheduleKind: 'once',
        rrule: null,
        dueDate: '2026-07-20',
        leadTimeDays: 10,
      });
      const stranger = await newMember(other.householdId);
      await tick(NOW);

      const result = await tick(HEADS_UP_TICK);

      expect(result).toMatchObject({ queued: 2, delivered: 4 });
      const rows = await notifications();
      const bins = rows.filter((n) => n.payload.taskTitle === 'Bins');
      expect(bins.map((n) => n.memberId).sort()).toEqual(people.map((m) => m.id).sort());
      expect(bins.every((n) => n.payload.assigneeId === null && n.sentAt !== null)).toBe(true);
      expect(rows.filter((n) => n.payload.taskTitle === 'Other').map((n) => n.memberId)).toEqual([
        stranger.id,
      ]);
    });

    it('cancels, rather than sends, a reminder that is more than a day late', async () => {
      await setup({ assignees: 1 });
      await tick(NOW);

      // The worker was down from before the heads-up until 30 hours after it.
      const result = await tick(at('2026-07-12T00:00:00Z'));

      expect(result).toMatchObject({ queued: 0, cancelled: 1, delivered: 0 });
      expect(await notifications()).toEqual([]);
      expect((await reminders()).find((r) => r.key === 'heads_up')?.status).toBe('cancelled');
    });

    it('logs an occurrence it cannot plan and still plans the others', async () => {
      await setup({ assignees: 1 });
      const broken = await newTask({ title: 'Broken' });
      await handle.db
        .update(household)
        .set({ timezone: 'Not/AZone' })
        .where(eq(household.id, broken.householdId));
      const [bad] = await handle.db
        .insert(occurrence)
        .values({ taskId: broken.id, dueDate: '2026-07-20', status: 'active' })
        .returning();

      const result = await tick(NOW);

      expect(result).toMatchObject({ skipped: false, planned: 5 });
      if (result.skipped) throw new Error('unreachable');
      expect(result.planFailures).toEqual([
        expect.objectContaining({ occurrenceId: bad?.id, taskId: broken.id }),
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ occurrenceId: bad?.id }),
        'could not plan reminders',
      );
    });

    it('reports an occurrence it cannot plan once, even when it has a reminder that fell due', async () => {
      const broken = await newTask({ title: 'Broken' });
      await handle.db
        .update(household)
        .set({ timezone: 'Not/AZone' })
        .where(eq(household.id, broken.householdId));
      const [bad] = await handle.db
        .insert(occurrence)
        .values({ taskId: broken.id, dueDate: '2026-07-20', status: 'active' })
        .returning();
      await handle.db.insert(reminder).values({
        occurrenceId: bad?.id ?? '',
        key: 'heads_up',
        kind: 'heads_up',
        fireAt: HEADS_UP_TICK,
      });

      const result = await tick(HEADS_UP_TICK);

      if (result.skipped) throw new Error('unreachable');
      expect(result.queued).toBe(0);
      expect(result.planFailures).toEqual([
        expect.objectContaining({ occurrenceId: bad?.id, taskId: broken.id }),
      ]);
      expect((await reminders()).find((r) => r.key === 'heads_up')?.status).toBe('planned');
    });

    it('does not send a due reminder the occurrence was reassigned away from since the last tick', async () => {
      const { people } = await setup({ assignees: 1, members: 2 });
      await tick(NOW);
      const o = await onlyOccurrence();
      const other = people[1];
      await handle.db
        .update(occurrence)
        .set({ assigneeId: other?.id ?? null })
        .where(eq(occurrence.id, o.id));

      const result = await tick(HEADS_UP_TICK);

      expect(result).toMatchObject({ queued: 0, delivered: 0 });
      expect(await notifications()).toEqual([]);
      // The re-plan in the same tick addressed what is left to the new assignee.
      expect((await planned()).every((r) => r.memberId === other?.id)).toBe(true);
    });

    it('prunes old notifications after delivering', async () => {
      await setup({ assignees: 1 });
      await tick(NOW);
      await tick(HEADS_UP_TICK);
      const [n] = await notifications();
      expect(n?.sentAt).not.toBeNull();
      // created_at is the database clock; put it where the tests' clock is.
      await handle.db.update(notification).set({ createdAt: HEADS_UP_TICK });

      const long = new Date(HEADS_UP_TICK.getTime() + 91 * 24 * 60 * 60 * 1000);
      const result = await tick(long);

      expect(result).toMatchObject({ skipped: false, pruned: 1 });
      expect(await notifications()).toEqual([]);
    });

    describe('heartbeat', () => {
      const beats = () => handle.db.select().from(serviceHeartbeat);

      it('is recorded by every tick', async () => {
        expect(await beats()).toEqual([]);

        await tick(NOW);
        expect(await beats()).toEqual([{ service: 'worker', beatAt: NOW }]);

        const later = at('2026-07-06T09:01:00Z');
        await tick(later);
        expect(await beats()).toEqual([{ service: 'worker', beatAt: later }]);
      });

      it('is recorded when another worker holds the tick lock', async () => {
        let release: () => void = () => {};
        let held: () => void = () => {};
        const holding = new Promise<void>((resolve) => (held = resolve));
        const holder = handle.sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(${TICK_LOCK_KEY}::bigint)`;
          held();
          await new Promise<void>((resolve) => (release = resolve));
        });
        await holding;
        try {
          expect(await tick(NOW)).toEqual({ skipped: true });
          expect(await beats()).toEqual([{ service: 'worker', beatAt: NOW }]);
        } finally {
          release();
          await holder;
        }
      });
    });

    // Plan row: "kill/restart the worker mid-run -> no duplicate or lost reminders".
    describe('survives a crash or restart without a duplicate or lost reminder', () => {
      /** Two members, one unassigned task: two notifications per due reminder. */
      async function twoRecipients() {
        const { people } = await setup({ members: 2 });
        await tick(NOW);
        return people;
      }

      it('when the worker dies after queueing, before the transaction commits', async () => {
        const people = await twoRecipients();

        // Queued and marked sent inside a tick that then crashes: all of it rolls back.
        await expect(
          handle.db.transaction(async (tx) => {
            const queued = await queueDueReminders(tx, { now: HEADS_UP_TICK });
            expect(queued).toMatchObject({ queued: 1, notifications: 2 });
            throw new Error('worker killed');
          }),
        ).rejects.toThrow('worker killed');
        expect(await notifications()).toEqual([]);
        expect((await planned()).map((r) => r.key)).toContain('heads_up');

        // The restarted worker's next tick sends it, once to each member.
        const result = await tick(HEADS_UP_TICK);
        expect(result).toMatchObject({ queued: 1, delivered: 2 });
        const rows = await notifications();
        expect(rows.map((n) => n.memberId).sort()).toEqual(people.map((m) => m.id).sort());
        expect(rows.every((n) => n.sentAt !== null)).toBe(true);

        expect(await tick(at('2026-07-10T18:01:30Z'))).toMatchObject({ queued: 0, delivered: 0 });
        expect(await notifications()).toHaveLength(2);
      });

      it('when the worker dies after queueing but before delivering', async () => {
        const people = await twoRecipients();

        // The tick's transaction committed (queued, marked sent); the process died before
        // delivery. The notifications wait in the outbox, undelivered.
        await handle.db.transaction((tx) => queueDueReminders(tx, { now: HEADS_UP_TICK }));
        const pending = await notifications();
        expect(pending).toHaveLength(2);
        expect(pending.every((n) => n.sentAt === null && n.attempts === 0)).toBe(true);

        // The next tick queues nothing new and delivers each one once.
        const result = await tick(at('2026-07-10T18:01:00Z'));
        expect(result).toMatchObject({ queued: 0, delivered: 2 });
        const rows = await notifications();
        expect(rows.map((n) => n.id).sort()).toEqual(pending.map((n) => n.id).sort());
        expect(rows.map((n) => n.memberId).sort()).toEqual(people.map((m) => m.id).sort());
        expect(rows.every((n) => n.sentAt !== null)).toBe(true);
        expect(await tick(at('2026-07-10T18:02:00Z'))).toMatchObject({ queued: 0, delivered: 0 });
      });

      it('when several workers tick at once', async () => {
        await twoRecipients();

        const results = await Promise.all([1, 2, 3, 4].map(() => tick(HEADS_UP_TICK)));

        // Some tick may have skipped for the lock, but together they queue and deliver it once.
        const ran = results.filter((r) => !r.skipped);
        expect(ran.length).toBeGreaterThanOrEqual(1);
        expect(ran.reduce((sum, r) => sum + r.queued, 0)).toBe(1);
        expect(ran.reduce((sum, r) => sum + r.delivered, 0)).toBe(2);
        expect(await notifications()).toHaveLength(2);
        expect((await notifications()).every((n) => n.sentAt !== null)).toBe(true);
        expect((await reminders()).filter((r) => r.status === 'sent')).toHaveLength(1);
      });

      it('when the same tick is repeated', async () => {
        await twoRecipients();

        for (let i = 0; i < 3; i += 1) await tick(HEADS_UP_TICK);

        expect(await notifications()).toHaveLength(2);
      });

      it('loses none across the whole life of the task', async () => {
        const { people } = await setup({ assignees: 1 });
        // Tick every day at the evening slot from the start until after the due date.
        const sentKeys = new Set<string>();
        for (let day = 6; day <= 21; day += 1) {
          await tick(at(`2026-07-${String(day).padStart(2, '0')}T09:00:00Z`));
          await tick(at(`2026-07-${String(day).padStart(2, '0')}T18:00:30Z`));
        }
        for (const r of await reminders()) if (r.status === 'sent') sentKeys.add(r.key);

        // Every reminder the plan had, up to the first overdue one, was sent once to the assignee.
        expect([...sentKeys].sort()).toEqual([...KEYS, 'overdue:2026-07-21'].sort());
        const rows = await notifications();
        expect(rows).toHaveLength(6);
        expect(rows.every((n) => n.memberId === people[0]?.id && n.sentAt !== null)).toBe(true);
        expect(new Set(rows.map((n) => n.dedupeKey)).size).toBe(6);
      });
    });
  });
});
