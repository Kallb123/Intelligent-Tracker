import { RecurrenceError } from '@tracker/core';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Database, type DbHandle } from './client.js';
import { setMemberAway } from './members.js';
import { runMigrations } from './migrate.js';
import {
  activity,
  household,
  member,
  occurrence,
  task,
  taskAssignee,
  taskMilestone,
} from './schema/index.js';
import { createTask, replaceTaskLists, type TaskValues } from './tasks.js';
import { createTestDatabase, type TestDatabase } from './test-db.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

// Wednesday 15 July 2026, 11:00 in London (BST).
const NOW = new Date('2026-07-15T10:00:00Z');

describe.skipIf(!adminUrl)('createTask and setMemberAway (integration)', () => {
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
  });

  let members = 0;
  async function setup() {
    const [h] = await db.insert(household).values({ name: 'Test' }).returning();
    if (!h) throw new Error('insert failed');
    const newMember = async (name: string) => {
      members += 1;
      const [m] = await db
        .insert(member)
        .values({ householdId: h.id, name, username: `${name.toLowerCase()}${members}` })
        .returning();
      if (!m) throw new Error('insert failed');
      return m;
    };
    return { h, sam: await newMember('Sam'), jo: await newMember('Jo') };
  }

  const values = (v: Partial<TaskValues> = {}): TaskValues => ({
    title: 'Put the bins out',
    scheduleKind: 'once',
    allDay: true,
    dueDate: '2026-07-16',
    assignmentMode: 'fixed',
    ...v,
  });

  describe('createTask', () => {
    it('inserts the task, its lists and its first occurrence, and logs it', async () => {
      const { h, sam, jo } = await setup();

      const created = await db.transaction((tx) =>
        createTask(tx, {
          householdId: h.id,
          createdBy: sam.id,
          values: values({ effortMinutes: 5 }),
          assigneeIds: [jo.id, sam.id],
          milestones: [
            { title: 'Find the key', offsetDaysBeforeDue: 2 },
            { title: 'Check the rota', offsetDaysBeforeDue: 1 },
          ],
          now: NOW,
        }),
      );

      expect(created).toMatchObject({
        householdId: h.id,
        createdBy: sam.id,
        title: 'Put the bins out',
        effortMinutes: 5,
        dueDate: '2026-07-16',
      });
      expect(
        await db.select().from(taskAssignee).orderBy(asc(taskAssignee.position)),
      ).toMatchObject([
        { taskId: created.id, memberId: jo.id, position: 0 },
        { taskId: created.id, memberId: sam.id, position: 1 },
      ]);
      expect(
        (await db.select().from(taskMilestone).orderBy(asc(taskMilestone.position))).map((m) => [
          m.title,
          m.offsetDaysBeforeDue,
          m.position,
        ]),
      ).toEqual([
        ['Find the key', 2, 0],
        ['Check the rota', 1, 1],
      ]);
      expect(await db.select().from(occurrence)).toMatchObject([
        { taskId: created.id, dueDate: '2026-07-16', assigneeId: jo.id },
      ]);
      expect(await db.select().from(activity)).toMatchObject([
        {
          householdId: h.id,
          memberId: sam.id,
          taskId: created.id,
          kind: 'task.created',
          data: { title: 'Put the bins out' },
        },
      ]);
    });

    it('makes an undated one-off for its one assignee', async () => {
      const { h, sam } = await setup();

      const created = await db.transaction((tx) =>
        createTask(tx, {
          householdId: h.id,
          createdBy: sam.id,
          values: values({ dueDate: null }),
          assigneeIds: [sam.id],
          milestones: [],
          now: NOW,
        }),
      );

      expect(await db.select().from(occurrence)).toMatchObject([
        { taskId: created.id, dueDate: null, dueAt: null, assigneeId: sam.id, status: 'active' },
      ]);
    });

    it('leaves nothing behind when the schedule cannot be materialised', async () => {
      const { h, sam } = await setup();

      await expect(
        db.transaction((tx) =>
          createTask(tx, {
            householdId: h.id,
            createdBy: sam.id,
            values: values({ scheduleKind: 'fixed', dueDate: null, rrule: 'not an rrule' }),
            assigneeIds: [],
            milestones: [],
            now: NOW,
          }),
        ),
      ).rejects.toBeInstanceOf(RecurrenceError);

      expect(await db.select().from(task)).toEqual([]);
      expect(await db.select().from(activity)).toEqual([]);
    });
  });

  describe('replaceTaskLists', () => {
    it('replaces only the lists it is given', async () => {
      const { h, sam, jo } = await setup();
      const created = await db.transaction((tx) =>
        createTask(tx, {
          householdId: h.id,
          createdBy: sam.id,
          values: values(),
          assigneeIds: [sam.id],
          milestones: [{ title: 'Old', offsetDaysBeforeDue: 1 }],
          now: NOW,
        }),
      );

      await replaceTaskLists(db, created.id, { assignees: [jo.id] });
      expect((await db.select().from(taskAssignee)).map((a) => a.memberId)).toEqual([jo.id]);
      expect((await db.select().from(taskMilestone)).map((m) => m.title)).toEqual(['Old']);

      await replaceTaskLists(db, created.id, { assignees: [], milestones: [] });
      expect(await db.select().from(taskAssignee)).toEqual([]);
      expect(await db.select().from(taskMilestone)).toEqual([]);
    });
  });

  describe('replaceTaskLists milestones', () => {
    const ms = (...specs: [string, number][]) =>
      specs.map(([title, offsetDaysBeforeDue]) => ({ title, offsetDaysBeforeDue }));
    const stored = async () =>
      (await db.select().from(taskMilestone).orderBy(asc(taskMilestone.position))).map((m) => ({
        id: m.id,
        title: m.title,
        offset: m.offsetDaysBeforeDue,
        position: m.position,
      }));

    async function withTask(milestones: ReturnType<typeof ms>) {
      const { h, sam } = await setup();
      const created = await db.transaction((tx) =>
        createTask(tx, {
          householdId: h.id,
          createdBy: sam.id,
          values: values(),
          assigneeIds: [sam.id],
          milestones,
          now: NOW,
        }),
      );
      const [occ] = await db.select().from(occurrence).where(eq(occurrence.taskId, created.id));
      return { task: created, occ: occ! };
    }

    const progressOf = async (id: string) =>
      (await db.select().from(occurrence).where(eq(occurrence.id, id)))[0]?.milestoneProgress;

    it('keeps the ids of milestones that stay, through renames of others, reorders and offset changes', async () => {
      const { task: t } = await withTask(ms(['A', 3], ['B', 2], ['C', 1]));
      const before = await stored();

      await db.transaction((tx) =>
        replaceTaskLists(tx, t.id, { milestones: ms(['C', 9], ['A', 3], ['B renamed', 2]) }),
      );

      const after = await stored();
      expect(after.map((m) => [m.title, m.offset, m.position])).toEqual([
        ['C', 9, 0],
        ['A', 3, 1],
        ['B renamed', 2, 2],
      ]);
      expect(after[0]?.id).toBe(before[2]?.id);
      expect(after[1]?.id).toBe(before[0]?.id);
      // The renamed one matches nothing, so it is new and the old B is gone.
      expect(after[2]?.id).not.toBe(before[1]?.id);
    });

    it('swaps two milestones while a third stays where it is, and re-saving the same list changes nothing', async () => {
      const { task: t } = await withTask(ms(['A', 3], ['B', 2], ['C', 1]));
      const before = await stored();

      await db.transaction((tx) =>
        replaceTaskLists(tx, t.id, { milestones: ms(['A', 3], ['C', 1], ['B', 2]) }),
      );
      const swapped = await stored();
      expect(swapped.map((m) => m.id)).toEqual([before[0]!.id, before[2]!.id, before[1]!.id]);
      expect(swapped.map((m) => m.position)).toEqual([0, 1, 2]);

      await db.transaction((tx) =>
        replaceTaskLists(tx, t.id, { milestones: ms(['A', 3], ['C', 1], ['B', 2]) }),
      );
      expect(await stored()).toEqual(swapped);
    });

    it('matches duplicate titles in order, taking the first unused one', async () => {
      const { task: t } = await withTask(ms(['Same', 3], ['Same', 2]));
      const before = await stored();
      await db.transaction((tx) =>
        replaceTaskLists(tx, t.id, { milestones: ms(['Same', 5], ['Same', 4], ['Same', 1]) }),
      );
      const after = await stored();
      expect(after.slice(0, 2).map((m) => m.id)).toEqual(before.map((m) => m.id));
      expect(after.map((m) => m.offset)).toEqual([5, 4, 1]);
    });

    it('removes the ids of deleted milestones from open occurrences only', async () => {
      const { task: t, occ } = await withTask(ms(['A', 3], ['B', 2]));
      const [a, b] = await stored();
      await db
        .update(occurrence)
        .set({ milestoneProgress: { [a!.id]: '2026-07-15T10:00:00Z', [b!.id]: true } })
        .where(eq(occurrence.id, occ.id));
      const [closed] = await db
        .insert(occurrence)
        .values({
          taskId: t.id,
          dueDate: '2026-07-01',
          status: 'done',
          milestoneProgress: { [b!.id]: true },
        })
        .returning();

      await db.transaction((tx) => replaceTaskLists(tx, t.id, { milestones: ms(['A', 3]) }));

      expect(await progressOf(occ.id)).toEqual({ [a!.id]: '2026-07-15T10:00:00Z' });
      expect(await progressOf(closed!.id)).toEqual({ [b!.id]: true });
      expect((await stored()).map((m) => m.id)).toEqual([a!.id]);
    });

    it('leaves occurrences alone when nothing was deleted, and adds new milestones', async () => {
      const { task: t, occ } = await withTask(ms(['A', 3]));
      const [a] = await stored();
      await db
        .update(occurrence)
        .set({ milestoneProgress: { [a!.id]: true } })
        .where(eq(occurrence.id, occ.id));

      await db.transaction((tx) =>
        replaceTaskLists(tx, t.id, { milestones: ms(['New', 5], ['A', 3]) }),
      );

      const after = await stored();
      expect(after.map((m) => [m.title, m.position])).toEqual([
        ['New', 0],
        ['A', 1],
      ]);
      expect(after[1]?.id).toBe(a!.id);
      expect(await progressOf(occ.id)).toEqual({ [a!.id]: true });
    });
  });

  describe('setMemberAway', () => {
    const away = (
      h: { id: string },
      actor: { id: string },
      target: string,
      awayUntil: string | null,
    ) =>
      db.transaction((tx) =>
        setMemberAway(tx, {
          householdId: h.id,
          actorId: actor.id,
          memberId: target,
          awayUntil,
          now: NOW,
        }),
      );

    it('sets and clears the date and logs who did it', async () => {
      const { h, sam, jo } = await setup();

      expect(await away(h, jo, sam.id, '2026-07-20')).toMatchObject({
        id: sam.id,
        awayUntil: '2026-07-20',
      });
      expect(await away(h, sam, sam.id, null)).toMatchObject({ id: sam.id, awayUntil: null });

      const [row] = await db.select().from(member).where(eq(member.id, sam.id));
      expect(row?.awayUntil).toBeNull();
      expect(
        (await db.select().from(activity).orderBy(asc(activity.createdAt))).map((a) => [
          a.kind,
          a.memberId,
          a.data,
        ]),
      ).toEqual([
        ['member.away_changed', jo.id, { memberId: sam.id, awayUntil: '2026-07-20' }],
        ['member.away_changed', sam.id, { memberId: sam.id, awayUntil: null }],
      ]);
    });

    it('changes and logs nothing when the date is the same', async () => {
      const { h, sam } = await setup();
      await away(h, sam, sam.id, '2026-07-20');

      expect(await away(h, sam, sam.id, '2026-07-20')).toMatchObject({ awayUntil: '2026-07-20' });
      expect(await db.select().from(activity)).toHaveLength(1);
    });

    it('is null for a member of another household', async () => {
      const { h, sam } = await setup();
      const other = await setup();

      expect(await away(h, sam, other.sam.id, '2026-07-20')).toBeNull();
      expect(await away(h, sam, '00000000-0000-4000-8000-000000000000', null)).toBeNull();
      const [row] = await db.select().from(member).where(eq(member.id, other.sam.id));
      expect(row?.awayUntil).toBeNull();
    });

    it('hands the rotation turn they miss to the next member', async () => {
      const { h, sam, jo } = await setup();
      await db.transaction((tx) =>
        createTask(tx, {
          householdId: h.id,
          createdBy: sam.id,
          values: values({ assignmentMode: 'rotation' }),
          assigneeIds: [sam.id, jo.id],
          milestones: [],
          now: NOW,
        }),
      );
      expect((await db.select().from(occurrence))[0]?.assigneeId).toBe(sam.id);

      await away(h, sam, sam.id, '2026-07-20');

      expect((await db.select().from(occurrence))[0]?.assigneeId).toBe(jo.id);
    });
  });
});
