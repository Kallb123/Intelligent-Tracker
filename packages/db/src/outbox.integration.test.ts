import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Database, type DbHandle } from './client.js';
import { recordHeartbeat } from './heartbeat.js';
import { runMigrations } from './migrate.js';
import {
  deliverOutbox,
  deliverOutboxBatches,
  OLD_NOTIFICATION_RETENTION_MS,
  outboxBackoffMs,
  pruneNotifications,
  READ_NOTIFICATION_RETENTION_MS,
  type OutboxBatchHandler,
  type OutboxHandler,
} from './outbox.js';
import {
  household,
  member,
  notification,
  serviceHeartbeat,
  type NewNotification,
} from './schema/index.js';
import { createTestDatabase, type TestDatabase } from './test-db.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

const at = (iso: string): Date => new Date(iso);
const NOW = at('2026-07-10T18:00:00Z');

describe.skipIf(!adminUrl)('outbox and heartbeat (integration)', () => {
  let testDb: TestDatabase;
  let handle: DbHandle;
  let db: Database;
  let householdId: string;
  let memberId: string;
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

  // Every test starts from an empty database (the household delete cascades to everything).
  beforeEach(async () => {
    await db.delete(household);
    await db.delete(serviceHeartbeat);
    const [h] = await db.insert(household).values({ name: 'Test' }).returning();
    const [m] = await db
      .insert(member)
      .values({ householdId: h?.id ?? '', name: 'Alex', username: 'alex' })
      .returning();
    householdId = h?.id ?? '';
    memberId = m?.id ?? '';
  });

  /** Queues a notification the way `queueDueReminders` does, with a unique dedupe key. */
  async function queue(values: Partial<NewNotification> = {}) {
    seq += 1;
    const [n] = await db
      .insert(notification)
      .values({
        householdId,
        memberId,
        channel: 'in_app',
        dedupeKey: `test:${seq}`,
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
          assigneeId: memberId,
        },
        ...values,
      })
      .returning();
    if (!n) throw new Error('insert failed');
    return n;
  }

  const row = async (id: string) => {
    const [n] = await db.select().from(notification).where(eq(notification.id, id));
    if (!n) throw new Error('missing');
    return n;
  };
  const ok: OutboxHandler = async () => {};

  describe('deliverOutbox', () => {
    it('hands each pending notification to its channel`s handler and stamps sent_at', async () => {
      const a = await queue();
      const b = await queue();
      const handler = vi.fn(ok);

      const result = await deliverOutbox(db, { now: NOW, handlers: { in_app: handler } });

      expect(result).toEqual({ delivered: 2, failures: [] });
      expect(handler.mock.calls.map(([n]) => n.id).sort()).toEqual([a.id, b.id].sort());
      expect(await row(a.id)).toMatchObject({ sentAt: NOW, failedAt: null, attempts: 0 });
      expect(await row(b.id)).toMatchObject({ sentAt: NOW });
    });

    it('does nothing the second time round', async () => {
      await queue();
      const handler = vi.fn(ok);
      await deliverOutbox(db, { now: NOW, handlers: { in_app: handler } });

      const again = await deliverOutbox(db, { now: NOW, handlers: { in_app: handler } });

      expect(again).toEqual({ delivered: 0, failures: [] });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('stores the Telegram message id a handler returns', async () => {
      const n = await queue({ channel: 'telegram_group', memberId: null });

      await deliverOutbox(db, {
        now: NOW,
        handlers: { telegram_group: async () => ({ telegramMessageId: 4_294_967_296 }) },
      });

      expect(await row(n.id)).toMatchObject({ sentAt: NOW, telegramMessageId: 4_294_967_296 });
    });

    it('only claims channels that have a handler', async () => {
      const inApp = await queue();
      const group = await queue({ channel: 'telegram_group', memberId: null });

      const result = await deliverOutbox(db, { now: NOW, handlers: { in_app: ok } });

      expect(result.delivered).toBe(1);
      expect((await row(inApp.id)).sentAt).toEqual(NOW);
      expect(await row(group.id)).toMatchObject({ sentAt: null, attempts: 0, failedAt: null });
      expect(await deliverOutbox(db, { now: NOW, handlers: {} })).toEqual({
        delivered: 0,
        failures: [],
      });
    });

    it('leaves notifications that are not yet due, sent or given up', async () => {
      await queue({ nextAttemptAt: at('2026-07-10T18:00:01Z') });
      await queue({ sentAt: at('2026-07-10T17:00:00Z') });
      await queue({ failedAt: at('2026-07-10T17:00:00Z') });
      const handler = vi.fn(ok);

      expect(await deliverOutbox(db, { now: NOW, handlers: { in_app: handler } })).toEqual({
        delivered: 0,
        failures: [],
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it('delivers oldest first and at most batchSize per call', async () => {
      const late = await queue({ nextAttemptAt: at('2026-07-10T17:50:00Z') });
      const early = await queue({ nextAttemptAt: at('2026-07-10T17:00:00Z') });
      const mid = await queue({ nextAttemptAt: at('2026-07-10T17:30:00Z') });
      const order: string[] = [];
      const handlers = {
        in_app: async (n: { id: string }) => {
          order.push(n.id);
        },
      };

      expect((await deliverOutbox(db, { now: NOW, handlers, batchSize: 2 })).delivered).toBe(2);
      expect(order).toEqual([early.id, mid.id]);
      expect((await row(late.id)).sentAt).toBeNull();

      expect((await deliverOutbox(db, { now: NOW, handlers, batchSize: 2 })).delivered).toBe(1);
      expect(order).toEqual([early.id, mid.id, late.id]);
    });

    it('retries a failed delivery with exponential backoff, then succeeds', async () => {
      const n = await queue();
      let calls = 0;
      const handlers = {
        in_app: async () => {
          calls += 1;
          if (calls <= 2) throw new Error(`boom ${calls}`);
        },
      };

      const first = await deliverOutbox(db, { now: NOW, handlers });
      expect(first).toEqual({
        delivered: 0,
        failures: [
          { notificationId: n.id, channel: 'in_app', attempts: 1, error: 'boom 1', gaveUp: false },
        ],
      });
      expect(await row(n.id)).toMatchObject({
        attempts: 1,
        lastError: 'boom 1',
        sentAt: null,
        failedAt: null,
        nextAttemptAt: new Date(NOW.getTime() + 30_000),
      });

      // Not due again until the backoff has passed.
      expect(await deliverOutbox(db, { now: at('2026-07-10T18:00:29Z'), handlers })).toEqual({
        delivered: 0,
        failures: [],
      });
      expect(calls).toBe(1);

      const t1 = at('2026-07-10T18:00:30Z');
      await deliverOutbox(db, { now: t1, handlers });
      expect(await row(n.id)).toMatchObject({
        attempts: 2,
        lastError: 'boom 2',
        nextAttemptAt: new Date(t1.getTime() + 60_000),
      });

      const t2 = at('2026-07-10T18:01:30Z');
      expect((await deliverOutbox(db, { now: t2, handlers })).delivered).toBe(1);
      expect(await row(n.id)).toMatchObject({ attempts: 2, lastError: null, sentAt: t2 });
    });

    it('gives up after maxAttempts and never claims the notification again', async () => {
      const n = await queue();
      const handler = vi.fn(async () => {
        throw new Error('still down');
      });
      let now = NOW;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const result = await deliverOutbox(db, {
          now,
          handlers: { in_app: handler },
          maxAttempts: 3,
        });
        expect(result.failures).toEqual([
          expect.objectContaining({ attempts: attempt, gaveUp: attempt === 3 }),
        ]);
        now = new Date(now.getTime() + outboxBackoffMs(attempt));
      }

      expect(await row(n.id)).toMatchObject({
        attempts: 3,
        lastError: 'still down',
        sentAt: null,
        failedAt: new Date(NOW.getTime() + outboxBackoffMs(1) + outboxBackoffMs(2)),
      });
      // Long after any backoff: nothing is attempted any more.
      const far = at('2026-08-10T00:00:00Z');
      expect(
        await deliverOutbox(db, { now: far, handlers: { in_app: handler }, maxAttempts: 3 }),
      ).toEqual({
        delivered: 0,
        failures: [],
      });
      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('gives up after eight attempts by default and records non-Error rejections', async () => {
      const n = await queue();
      const handlers = {
        in_app: async () => {
          throw 'plain string';
        },
      };
      let now = NOW;
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        await deliverOutbox(db, { now, handlers });
        now = new Date(now.getTime() + outboxBackoffMs(attempt));
      }

      expect(await row(n.id)).toMatchObject({
        attempts: 8,
        lastError: 'plain string',
        failedAt: expect.any(Date),
      });
    });

    it('goes on with the other notifications when one fails', async () => {
      const bad = await queue({ nextAttemptAt: at('2026-07-10T17:00:00Z') });
      const good = await queue();

      const result = await deliverOutbox(db, {
        now: NOW,
        handlers: {
          in_app: async (n) => {
            if (n.id === bad.id) throw new Error('nope');
          },
        },
      });

      expect(result.delivered).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect((await row(good.id)).sentAt).toEqual(NOW);
      expect((await row(bad.id)).sentAt).toBeNull();
    });

    it('skips a notification another deliverer has claimed', async () => {
      const held = await queue({ nextAttemptAt: at('2026-07-10T17:00:00Z') });
      const free = await queue();
      let release: () => void = () => {};
      let claimed: () => void = () => {};
      const waiting = new Promise<void>((resolve) => (claimed = resolve));
      const other = db.transaction(async (tx) => {
        await tx.select().from(notification).where(eq(notification.id, held.id)).for('update');
        claimed();
        await new Promise<void>((resolve) => (release = resolve));
      });
      await waiting;
      try {
        const handler = vi.fn(ok);
        const result = await deliverOutbox(db, { now: NOW, handlers: { in_app: handler } });

        expect(result.delivered).toBe(1);
        expect(handler.mock.calls.map(([n]) => n.id)).toEqual([free.id]);
      } finally {
        release();
        await other;
      }
      expect((await row(held.id)).sentAt).toBeNull();
    });

    it('delivers each notification once when deliverers run at once', async () => {
      const ids = (await Promise.all(Array.from({ length: 12 }, () => queue()))).map((n) => n.id);
      const delivered: string[] = [];
      const handlers = {
        in_app: async (n: { id: string }) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          delivered.push(n.id);
        },
      };

      const results = await Promise.all(
        [1, 2, 3, 4].map(() => deliverOutbox(db, { now: NOW, handlers })),
      );

      expect(results.reduce((sum, r) => sum + r.delivered, 0)).toBe(12);
      expect([...delivered].sort()).toEqual([...ids].sort());
      const rows = await db.select().from(notification).orderBy(asc(notification.id));
      expect(rows.every((n) => n.sentAt !== null && n.attempts === 0)).toBe(true);
    });
  });

  describe('deliverOutboxBatches', () => {
    const queueGroup = (values: Partial<NewNotification> = {}) =>
      queue({ channel: 'telegram_group', memberId: null, ...values });
    const okBatch: OutboxBatchHandler = async () => {};
    const otherHousehold = async () => {
      const [h] = await db.insert(household).values({ name: 'Other' }).returning();
      return h?.id ?? '';
    };
    const ids = (rows: { id: string }[]) => rows.map((n) => n.id);

    it('hands every pending row of a household to the handler as one batch', async () => {
      const a = await queueGroup();
      const b = await queueGroup();
      const handler = vi.fn<OutboxBatchHandler>(async () => ({ telegramMessageId: 4_294_967_296 }));

      const result = await deliverOutboxBatches(db, {
        now: NOW,
        channel: 'telegram_group',
        handler,
      });

      expect(result).toEqual({ delivered: 2, failures: [] });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(ids(handler.mock.calls[0]?.[0] ?? []).sort()).toEqual([a.id, b.id].sort());
      for (const n of [a, b]) {
        expect(await row(n.id)).toMatchObject({
          sentAt: NOW,
          lastError: null,
          attempts: 0,
          telegramMessageId: 4_294_967_296,
        });
      }
    });

    it('sends one batch per household, the household with the oldest row first', async () => {
      const other = await otherHousehold();
      const mine1 = await queueGroup({ nextAttemptAt: at('2026-07-10T17:30:00Z') });
      const theirs = await queueGroup({
        householdId: other,
        nextAttemptAt: at('2026-07-10T17:00:00Z'),
      });
      const mine2 = await queueGroup({ nextAttemptAt: at('2026-07-10T17:45:00Z') });
      const batches: string[][] = [];
      let messageId = 100;
      const handler: OutboxBatchHandler = async (rows) => {
        batches.push(ids(rows));
        return { telegramMessageId: (messageId += 1) };
      };

      const result = await deliverOutboxBatches(db, {
        now: NOW,
        channel: 'telegram_group',
        handler,
      });

      expect(result.delivered).toBe(3);
      expect(batches).toEqual([[theirs.id], [mine1.id, mine2.id]]);
      expect((await row(theirs.id)).telegramMessageId).toBe(101);
      expect((await row(mine1.id)).telegramMessageId).toBe(102);
      expect((await row(mine2.id)).telegramMessageId).toBe(102);
    });

    it('splits a household into batches of at most batchSize, oldest first', async () => {
      const queued = [];
      for (let i = 0; i < 5; i += 1) {
        queued.push(await queueGroup({ nextAttemptAt: new Date(NOW.getTime() - (5 - i) * 1000) }));
      }
      const batches: string[][] = [];
      const handler: OutboxBatchHandler = async (rows) => {
        batches.push(ids(rows));
      };

      const result = await deliverOutboxBatches(db, {
        now: NOW,
        channel: 'telegram_group',
        handler,
        batchSize: 2,
      });

      expect(result.delivered).toBe(5);
      expect(batches).toEqual([
        [queued[0]?.id, queued[1]?.id],
        [queued[2]?.id, queued[3]?.id],
        [queued[4]?.id],
      ]);
    });

    it('stops after maxBatches and leaves the rest pending', async () => {
      for (let i = 0; i < 5; i += 1) await queueGroup();
      const handler = vi.fn(okBatch);

      const result = await deliverOutboxBatches(db, {
        now: NOW,
        channel: 'telegram_group',
        handler,
        batchSize: 2,
        maxBatches: 2,
      });

      expect(result.delivered).toBe(4);
      expect(handler).toHaveBeenCalledTimes(2);
      const left = await deliverOutboxBatches(db, { now: NOW, channel: 'telegram_group', handler });
      expect(left.delivered).toBe(1);
    });

    it('only claims rows of its channel that are due, unsent and not given up', async () => {
      const inApp = await queue();
      await queueGroup({ nextAttemptAt: at('2026-07-10T18:00:01Z') });
      await queueGroup({ sentAt: at('2026-07-10T17:00:00Z') });
      await queueGroup({ failedAt: at('2026-07-10T17:00:00Z') });
      const handler = vi.fn(okBatch);

      const result = await deliverOutboxBatches(db, {
        now: NOW,
        channel: 'telegram_group',
        handler,
      });

      expect(result).toEqual({ delivered: 0, failures: [] });
      expect(handler).not.toHaveBeenCalled();
      expect((await row(inApp.id)).sentAt).toBeNull();
    });

    it('counts a failed attempt, with backoff, on every row of the batch, then succeeds', async () => {
      const a = await queueGroup();
      const b = await queueGroup();
      let calls = 0;
      const handler: OutboxBatchHandler = async () => {
        calls += 1;
        if (calls === 1) throw new Error('telegram down');
      };

      const first = await deliverOutboxBatches(db, {
        now: NOW,
        channel: 'telegram_group',
        handler,
      });

      expect(first.delivered).toBe(0);
      expect(first.failures).toHaveLength(2);
      expect(first.failures).toEqual(
        expect.arrayContaining(
          [a, b].map((n) => ({
            notificationId: n.id,
            channel: 'telegram_group',
            attempts: 1,
            error: 'telegram down',
            gaveUp: false,
          })),
        ),
      );
      // The failed batch is not retried within the same call.
      expect(calls).toBe(1);
      for (const n of [a, b]) {
        expect(await row(n.id)).toMatchObject({
          attempts: 1,
          lastError: 'telegram down',
          sentAt: null,
          failedAt: null,
          telegramMessageId: null,
          nextAttemptAt: new Date(NOW.getTime() + 30_000),
        });
      }

      const retryAt = at('2026-07-10T18:00:30Z');
      const second = await deliverOutboxBatches(db, {
        now: retryAt,
        channel: 'telegram_group',
        handler,
      });
      expect(second.delivered).toBe(2);
      expect(await row(a.id)).toMatchObject({ attempts: 1, lastError: null, sentAt: retryAt });
    });

    it('gives up on every row of the batch after maxAttempts', async () => {
      const a = await queueGroup();
      const b = await queueGroup({ attempts: 1 });
      const handler: OutboxBatchHandler = async () => {
        throw new Error('still down');
      };

      const result = await deliverOutboxBatches(db, {
        now: NOW,
        channel: 'telegram_group',
        handler,
        maxAttempts: 2,
      });

      // Rows are judged by their own attempts: b gives up, a has one more try.
      expect(result.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ notificationId: a.id, attempts: 1, gaveUp: false }),
          expect.objectContaining({ notificationId: b.id, attempts: 2, gaveUp: true }),
        ]),
      );
      expect((await row(a.id)).failedAt).toBeNull();
      expect((await row(b.id)).failedAt).toEqual(NOW);
    });

    it('does not let a failed batch hold back the next household', async () => {
      const other = await otherHousehold();
      const bad = await queueGroup({ nextAttemptAt: at('2026-07-10T17:00:00Z') });
      const good = await queueGroup({ householdId: other });

      const result = await deliverOutboxBatches(db, {
        now: NOW,
        channel: 'telegram_group',
        handler: async (rows) => {
          if (rows.some((n) => n.id === bad.id)) throw new Error('nope');
        },
      });

      expect(result.delivered).toBe(1);
      expect(result.failures.map((f) => f.notificationId)).toEqual([bad.id]);
      expect((await row(good.id)).sentAt).toEqual(NOW);
    });

    it('skips rows another deliverer has claimed', async () => {
      const held = await queueGroup({ nextAttemptAt: at('2026-07-10T17:00:00Z') });
      const free = await queueGroup();
      let release: () => void = () => {};
      let claimed: () => void = () => {};
      const waiting = new Promise<void>((resolve) => (claimed = resolve));
      const other = db.transaction(async (tx) => {
        await tx.select().from(notification).where(eq(notification.id, held.id)).for('update');
        claimed();
        await new Promise<void>((resolve) => (release = resolve));
      });
      await waiting;
      try {
        const handler = vi.fn(okBatch);
        const result = await deliverOutboxBatches(db, {
          now: NOW,
          channel: 'telegram_group',
          handler,
        });

        expect(result.delivered).toBe(1);
        expect(handler.mock.calls.map(([rows]) => ids(rows))).toEqual([[free.id]]);
      } finally {
        release();
        await other;
      }
      expect((await row(held.id)).sentAt).toBeNull();
    });

    it('delivers each row once when deliverers run at once', async () => {
      const queued = (await Promise.all(Array.from({ length: 12 }, () => queueGroup()))).map(
        (n) => n.id,
      );
      const delivered: string[] = [];
      const handler: OutboxBatchHandler = async (rows) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        delivered.push(...ids(rows));
      };

      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          deliverOutboxBatches(db, { now: NOW, channel: 'telegram_group', handler, batchSize: 3 }),
        ),
      );

      expect(results.reduce((sum, r) => sum + r.delivered, 0)).toBe(12);
      expect([...delivered].sort()).toEqual([...queued].sort());
      const rows = await db.select().from(notification);
      expect(rows.every((n) => n.sentAt !== null && n.attempts === 0)).toBe(true);
    });
  });

  describe('pruneNotifications', () => {
    const ago = (ms: number, extra = 0) => new Date(NOW.getTime() - ms + extra);
    const remaining = async () =>
      (await db.select({ id: notification.id }).from(notification)).map((n) => n.id).sort();

    it('deletes in-app notifications read more than 30 days ago, and keeps newer reads', async () => {
      const old = await queue({ sentAt: NOW, readAt: ago(READ_NOTIFICATION_RETENTION_MS, -1) });
      const edge = await queue({ sentAt: NOW, readAt: ago(READ_NOTIFICATION_RETENTION_MS) });
      const recent = await queue({ sentAt: NOW, readAt: ago(24 * 60 * 60 * 1000) });
      const unread = await queue({ sentAt: NOW });

      expect(await pruneNotifications(db, { now: NOW })).toBe(1);

      expect(await remaining()).toEqual([edge.id, recent.id, unread.id].sort());
      expect(await remaining()).not.toContain(old.id);
    });

    it('deletes delivered or failed notifications more than 90 days old, read or not', async () => {
      const oldCreated = ago(OLD_NOTIFICATION_RETENTION_MS, -1);
      const sent = await queue({ sentAt: NOW, createdAt: oldCreated });
      const failed = await queue({ failedAt: NOW, createdAt: oldCreated });
      const youngSent = await queue({ sentAt: NOW, createdAt: ago(OLD_NOTIFICATION_RETENTION_MS) });
      const youngFailed = await queue({ failedAt: NOW, createdAt: ago(24 * 60 * 60 * 1000) });
      // Not an in-app notification, so only the 90 day rule applies to it.
      const telegram = await queue({
        channel: 'telegram_group',
        memberId: null,
        sentAt: NOW,
        createdAt: oldCreated,
      });
      const oldTelegramRead = await queue({
        channel: 'telegram_group',
        memberId: null,
        sentAt: NOW,
        readAt: ago(READ_NOTIFICATION_RETENTION_MS, -1),
      });

      expect(await pruneNotifications(db, { now: NOW })).toBe(3);

      expect(await remaining()).toEqual([youngSent.id, youngFailed.id, oldTelegramRead.id].sort());
      expect(await remaining()).not.toContain(sent.id);
      expect(await remaining()).not.toContain(failed.id);
      expect(await remaining()).not.toContain(telegram.id);
    });

    it('never deletes a notification that is still waiting for delivery', async () => {
      const ancient = new Date(NOW.getTime() - 2 * OLD_NOTIFICATION_RETENTION_MS);
      const pending = await queue({ createdAt: ancient });
      // Not a state the api produces (it only reads sent ones), but pending is still safe.
      const pendingRead = await queue({
        createdAt: ancient,
        readAt: ago(READ_NOTIFICATION_RETENTION_MS, -1),
      });
      const retrying = await queue({ createdAt: ancient, attempts: 3, lastError: 'boom' });

      expect(await pruneNotifications(db, { now: NOW })).toBe(0);

      expect(await remaining()).toEqual([pending.id, pendingRead.id, retrying.id].sort());
    });

    it('does nothing on an empty table or when everything is recent', async () => {
      expect(await pruneNotifications(db, { now: NOW })).toBe(0);
      await queue({ sentAt: NOW });
      expect(await pruneNotifications(db, { now: NOW })).toBe(0);
      expect(await remaining()).toHaveLength(1);
    });
  });

  describe('recordHeartbeat', () => {
    it('creates the service`s row and then moves it forward', async () => {
      await recordHeartbeat(db, 'worker', NOW);
      expect(await db.select().from(serviceHeartbeat)).toEqual([
        { service: 'worker', beatAt: NOW },
      ]);

      const later = at('2026-07-10T18:01:00Z');
      await recordHeartbeat(db, 'worker', later);
      await recordHeartbeat(db, 'bot', NOW);

      const rows = await db.select().from(serviceHeartbeat).orderBy(asc(serviceHeartbeat.service));
      expect(rows).toEqual([
        { service: 'bot', beatAt: NOW },
        { service: 'worker', beatAt: later },
      ]);
    });
  });
});
