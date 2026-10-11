import { activity, member, occurrence, type DbHandle } from '@tracker/db';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TestClient,
  addMember,
  addOutsider,
  createMigratedDatabase,
  createTestApp,
  setUpAdmin,
  type TestApp,
} from './test-util.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

const DAY = 24 * 60 * 60 * 1000;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// The test clock starts at 2026-03-01T12:00:00Z, a Sunday; the household is on London time (GMT).
describe.skipIf(!adminUrl)('member away dates (integration)', () => {
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let handle: DbHandle;
  let app: FastifyInstance;
  let clock: TestApp['clock'];
  let admin: TestClient;

  beforeAll(async () => {
    database = await createMigratedDatabase(adminUrl as string);
    handle = database.handle;
  });
  afterAll(() => database?.close());

  beforeEach(async () => {
    await handle.sql`truncate household cascade`;
    ({ app, clock } = createTestApp(handle, { sessionTtlMs: 365 * DAY }));
    admin = await setUpAdmin(app);
  });

  const meOf = async (client: TestClient) => (await client.get('/api/auth/me')).json<Json>().member;

  describe('access', () => {
    it('needs a session and the CSRF token', async () => {
      const sam = await addMember(app, admin);
      const url = `/api/members/${sam.id}/away`;
      const body = { awayUntil: '2026-03-10' };

      expect((await new TestClient(app).patch(url, body, { csrf: false })).statusCode).toBe(401);
      expect((await admin.patch(url, body, { csrf: false })).statusCode).toBe(403);
    });

    it('lets a member set and clear their own away date', async () => {
      const sam = await addMember(app, admin);
      const url = `/api/members/${sam.id}/away`;

      const set = await sam.client.patch(url, { awayUntil: '2026-03-10' });
      expect(set.statusCode).toBe(200);
      expect(set.json<Json>().member).toMatchObject({ id: sam.id, awayUntil: '2026-03-10' });
      expect((await meOf(sam.client)).awayUntil).toBe('2026-03-10');

      const cleared = await sam.client.patch(url, { awayUntil: null });
      expect(cleared.json<Json>().member).toMatchObject({ awayUntil: null });
    });

    it('lets an admin set anyone`s, but not another plain member', async () => {
      const sam = await addMember(app, admin);
      const jo = await addMember(app, admin, { name: 'Jo', username: 'jo', email: 'jo@x.com' });

      const byAdmin = await admin.patch(`/api/members/${sam.id}/away`, { awayUntil: '2026-03-05' });
      expect(byAdmin.statusCode).toBe(200);
      expect(byAdmin.json<Json>().member.awayUntil).toBe('2026-03-05');

      const other = await jo.client.patch(`/api/members/${sam.id}/away`, { awayUntil: null });
      expect(other.statusCode).toBe(403);
      expect(other.json()).toMatchObject({ error: 'forbidden' });
      const adminId = (await meOf(admin)).id;
      expect(
        (await jo.client.patch(`/api/members/${adminId}/away`, { awayUntil: '2026-03-05' }))
          .statusCode,
      ).toBe(403);
      // Nothing changed.
      const [row] = await handle.db.select().from(member).where(eq(member.id, sam.id));
      expect(row?.awayUntil).toBe('2026-03-05');
    });

    it('answers 404 for a member of another household, even to an admin', async () => {
      const outsider = await addOutsider(app, handle);
      const res = await admin.patch(`/api/members/${outsider.memberId}/away`, {
        awayUntil: '2026-03-05',
      });
      expect(res.statusCode).toBe(404);
      const [row] = await handle.db.select().from(member).where(eq(member.id, outsider.memberId));
      expect(row?.awayUntil).toBeNull();
      const missing = await admin.patch('/api/members/00000000-0000-4000-8000-000000000000/away', {
        awayUntil: null,
      });
      expect(missing.statusCode).toBe(404);
    });

    it('validates the id and the body', async () => {
      const sam = await addMember(app, admin);
      expect((await admin.patch('/api/members/nope/away', { awayUntil: null })).statusCode).toBe(
        400,
      );
      for (const body of [
        {},
        { awayUntil: '2026-02-30' },
        { awayUntil: 'soon' },
        { awayUntil: 5 },
      ]) {
        const res = await admin.patch(`/api/members/${sam.id}/away`, body);
        expect([JSON.stringify(body), res.statusCode]).toEqual([JSON.stringify(body), 400]);
      }
    });
  });

  it('shows the away date in the members list', async () => {
    const sam = await addMember(app, admin);
    await sam.client.patch(`/api/members/${sam.id}/away`, { awayUntil: '2026-03-10' });
    const members = (await admin.get('/api/members')).json<Json>().members;
    expect(members.map((m: Json) => [m.username, m.awayUntil])).toEqual([
      ['kallum', null],
      ['sam', '2026-03-10'],
    ]);
  });

  it('logs the change once, not when nothing changes', async () => {
    const sam = await addMember(app, admin);
    const url = `/api/members/${sam.id}/away`;
    await sam.client.patch(url, { awayUntil: '2026-03-10' });
    await sam.client.patch(url, { awayUntil: '2026-03-10' });
    await sam.client.patch(url, { awayUntil: null });

    const log = await handle.db
      .select()
      .from(activity)
      .where(eq(activity.kind, 'member.away_changed'))
      .orderBy(asc(activity.createdAt));
    expect(log.map((a) => [a.memberId, a.data])).toEqual([
      [sam.id, { memberId: sam.id, awayUntil: '2026-03-10' }],
      [sam.id, { memberId: sam.id, awayUntil: null }],
    ]);
  });

  describe('rotation', () => {
    const weekly = {
      title: 'Hoover',
      scheduleKind: 'fixed',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      dueDate: '2026-03-02',
      assignmentMode: 'rotation',
    };

    async function rotation() {
      const sam = await addMember(app, admin);
      const me = await meOf(admin);
      const res = await admin.post('/api/tasks', { ...weekly, assigneeIds: [me.id, sam.id] });
      expect(res.statusCode, res.body).toBe(201);
      const taskId = res.json<Json>().task.id as string;
      const names = { [me.id]: 'me', [sam.id]: 'sam' };
      const plan = async (count = 6) =>
        (
          await handle.db
            .select()
            .from(occurrence)
            .where(eq(occurrence.taskId, taskId))
            .orderBy(asc(occurrence.dueDate))
        )
          .slice(0, count)
          .map((r) => (r.assigneeId ? names[r.assigneeId] : null));
      return { sam, me, taskId, plan };
    }

    it('skips an away member on the dates they are away and takes them back after', async () => {
      const { sam, plan } = await rotation();
      expect(await plan()).toEqual(['me', 'sam', 'me', 'sam', 'me', 'sam']);

      // Away through Monday 9 March: their turn for the 9th goes to the admin, and Sam is
      // back for the 16th.
      await sam.client.patch(`/api/members/${sam.id}/away`, { awayUntil: '2026-03-09' });
      expect(await plan()).toEqual(['me', 'me', 'sam', 'me', 'sam', 'me']);

      await sam.client.patch(`/api/members/${sam.id}/away`, { awayUntil: null });
      expect(await plan()).toEqual(['me', 'sam', 'me', 'sam', 'me', 'sam']);
    });

    it('judges the away date by the household`s local day (London, BST)', async () => {
      clock.set('2026-07-01T12:00:00Z');
      const sam = await addMember(app, admin);
      const me = await meOf(admin);
      // Due 23:30 UTC, which is 00:30 the next day in London: the dues fall on 11 and 12 July.
      const res = await admin.post('/api/tasks', {
        title: 'Late bins',
        scheduleKind: 'fixed',
        allDay: false,
        dueAt: '2026-07-10T23:30:00Z',
        rrule: 'FREQ=DAILY',
        assignmentMode: 'rotation',
        assigneeIds: [sam.id, me.id],
      });
      expect(res.statusCode, res.body).toBe(201);
      const names = { [me.id]: 'me', [sam.id]: 'sam' };
      const firstTwo = async () =>
        (await handle.db.select().from(occurrence).orderBy(asc(occurrence.dueAt)).limit(2)).map(
          (r) => names[r.assigneeId as string],
        );
      const setAway = (awayUntil: string) =>
        sam.client.patch(`/api/members/${sam.id}/away`, { awayUntil });

      // Away through the 10th: the first due is the 11th locally, so Sam is back for it.
      await setAway('2026-07-10');
      expect(await firstTwo()).toEqual(['sam', 'me']);
      // Away through the 11th: that due is skipped, and the one on the 12th is not.
      await setAway('2026-07-11');
      expect(await firstTwo()).toEqual(['me', 'sam']);
    });

    it('leaves started occurrences with whoever is doing them', async () => {
      const { sam, plan } = await rotation();
      const [, second] = await handle.db.select().from(occurrence).orderBy(asc(occurrence.dueDate));
      await sam.client.post(`/api/occurrences/${second?.id}/start`);

      await sam.client.patch(`/api/members/${sam.id}/away`, { awayUntil: '2026-12-31' });

      const [row] = await handle.db
        .select()
        .from(occurrence)
        .where(eq(occurrence.id, second?.id as string));
      expect(row).toMatchObject({ status: 'started', assigneeId: sam.id });
      expect((await plan()).filter((who) => who === 'sam')).toEqual(['sam']);
    });
  });
});
