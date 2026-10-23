import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Database, type DbHandle } from './client.js';
import { runMigrations } from './migrate.js';
import { deliverOutbox } from './outbox.js';
import {
  household,
  member,
  notification,
  pushSubscription,
  type NewNotification,
} from './schema/index.js';
import { createTestDatabase, type TestDatabase } from './test-db.js';
import {
  createWebPushHandler,
  PUSH_APP_TITLE,
  PUSH_TTL_SECONDS,
  type PushPartialFailure,
  type PushSender,
} from './web-push.js';

// Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres).
const adminUrl = process.env['TEST_DATABASE_URL'];

const at = (iso: string): Date => new Date(iso);
const NOW = at('2026-07-10T18:00:00Z');
const OCCURRENCE_ID = '00000000-0000-4000-8000-000000000002';

/** An error as the `web-push` library throws it: the push service's HTTP status on `statusCode`. */
const pushError = (statusCode: number, message = `status ${statusCode}`) =>
  Object.assign(new Error(message), { statusCode });

describe.skipIf(!adminUrl)('Web Push delivery (integration)', () => {
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
    const [h] = await db
      .insert(household)
      .values({ name: 'Test', timezone: 'Europe/London' })
      .returning();
    const [m] = await db
      .insert(member)
      .values({ householdId: h?.id ?? '', name: 'Alex', username: 'alex' })
      .returning();
    householdId = h?.id ?? '';
    memberId = m?.id ?? '';
  });

  async function subscribe(endpoint: string, forMember = memberId) {
    const [s] = await db
      .insert(pushSubscription)
      .values({ memberId: forMember, endpoint, p256dh: `p-${endpoint}`, auth: `a-${endpoint}` })
      .returning();
    if (!s) throw new Error('insert failed');
    return s;
  }

  /** Queues a `web_push` notification the way `queueDueReminders` does. */
  async function queue(payload: Partial<NewNotification['payload']> = {}, forMember = memberId) {
    seq += 1;
    const [n] = await db
      .insert(notification)
      .values({
        householdId,
        memberId: forMember,
        channel: 'web_push',
        dedupeKey: `test:${seq}`,
        nextAttemptAt: NOW,
        payload: {
          type: 'reminder',
          kind: 'due',
          taskId: '00000000-0000-4000-8000-000000000001',
          occurrenceId: OCCURRENCE_ID,
          taskTitle: 'Bins',
          dueDate: '2026-07-10',
          dueAt: null,
          fireAt: '2026-07-10T07:00:00.000Z',
          assigneeId: forMember,
          ...payload,
        },
      })
      .returning();
    if (!n) throw new Error('insert failed');
    return n;
  }

  const deliver = (send: PushSender, onPartialFailure?: (failure: PushPartialFailure) => void) =>
    deliverOutbox(db, {
      now: NOW,
      handlers: {
        web_push: createWebPushHandler(db, {
          send,
          now: NOW,
          ...(onPartialFailure ? { onPartialFailure } : {}),
        }),
      },
    });
  const subscriptions = () => db.select().from(pushSubscription).orderBy(pushSubscription.endpoint);
  const stored = async (id: string) =>
    (await db.select().from(notification).where(eq(notification.id, id)))[0];

  it('sends the rendered reminder to each of the member`s browsers and stamps them', async () => {
    const phone = await subscribe('https://fcm.googleapis.com/fcm/send/phone');
    await subscribe('https://fcm.googleapis.com/fcm/send/laptop');
    const other = await db
      .insert(member)
      .values({ householdId, name: 'Sam', username: 'sam' })
      .returning();
    await subscribe('https://fcm.googleapis.com/fcm/send/other', other[0]?.id);
    const n = await queue();
    const send = vi.fn<PushSender>(async () => {});

    const result = await deliver(send);

    expect(result).toEqual({ delivered: 1, failures: [] });
    expect(send).toHaveBeenCalledTimes(2);
    const message = {
      title: PUSH_APP_TITLE,
      body: 'Bins is due today',
      tag: `occurrence:${OCCURRENCE_ID}`,
      url: '/',
    };
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: phone.endpoint, p256dh: phone.p256dh, auth: phone.auth }),
      message,
      { ttlSeconds: PUSH_TTL_SECONDS, urgency: 'high' },
    );
    expect(send.mock.calls.map(([target]) => target.endpoint).sort()).toEqual([
      'https://fcm.googleapis.com/fcm/send/laptop',
      'https://fcm.googleapis.com/fcm/send/phone',
    ]);
    expect(await stored(n.id)).toMatchObject({ sentAt: NOW, attempts: 0, lastError: null });
    const rows = await subscriptions();
    expect(rows.map((s) => [s.endpoint.split('/').pop(), s.lastSentAt])).toEqual([
      ['laptop', NOW],
      ['other', null],
      ['phone', NOW],
    ]);
  });

  it('renders times in the household`s zone', async () => {
    await db.update(household).set({ timezone: 'America/New_York' });
    await subscribe('https://fcm.googleapis.com/fcm/send/phone');
    await queue({ dueDate: null, dueAt: '2026-07-10T17:30:00.000Z' });
    const send = vi.fn<PushSender>(async () => {});

    await deliver(send);

    expect(send.mock.calls[0]?.[1].body).toBe('Bins is due today at 13:30');
  });

  it('uses high urgency for due and overdue reminders and normal for the rest', async () => {
    await subscribe('https://fcm.googleapis.com/fcm/send/phone');
    for (const kind of ['heads_up', 'milestone', 'nudge', 'due', 'overdue'] as const) {
      await queue({ kind, ...(kind === 'overdue' ? { overdueDays: 2 } : {}) });
    }
    const send = vi.fn<PushSender>(async () => {});

    await deliver(send);

    // Rows are claimed in no particular order (same time, random ids).
    const urgencies = send.mock.calls.map(([, message, options]) => [
      message.body,
      options.urgency,
    ]);
    expect(urgencies).toHaveLength(5);
    expect(urgencies).toEqual(
      expect.arrayContaining([
        ['Coming up: Bins (due 10 Jul 2026)', 'normal'],
        ['Bins', 'normal'],
        ['Reminder: Bins is due 10 Jul 2026', 'normal'],
        ['Bins is due today', 'high'],
        ['Bins is 2 days overdue', 'high'],
      ]),
    );
  });

  it('deletes a subscription the push service says is gone, and delivers to the rest', async () => {
    await subscribe('https://fcm.googleapis.com/fcm/send/old');
    await subscribe('https://fcm.googleapis.com/fcm/send/gone');
    await subscribe('https://fcm.googleapis.com/fcm/send/new');
    const n = await queue();
    const send: PushSender = async (target) => {
      if (target.endpoint.endsWith('/old')) throw pushError(404);
      if (target.endpoint.endsWith('/gone')) throw pushError(410);
    };

    const result = await deliver(send);

    expect(result).toEqual({ delivered: 1, failures: [] });
    expect((await subscriptions()).map((s) => s.endpoint)).toEqual([
      'https://fcm.googleapis.com/fcm/send/new',
    ]);
    expect((await subscriptions())[0]?.lastSentAt).toEqual(NOW);
    expect((await stored(n.id))?.sentAt).toEqual(NOW);
  });

  it('counts one accepted browser as delivered, keeping the one that failed', async () => {
    await subscribe('https://fcm.googleapis.com/fcm/send/ok');
    await subscribe('https://fcm.googleapis.com/fcm/send/flaky');
    const n = await queue();
    const send: PushSender = async (target) => {
      if (target.endpoint.endsWith('/flaky')) throw pushError(503);
    };

    const result = await deliver(send);

    expect(result).toEqual({ delivered: 1, failures: [] });
    expect(await stored(n.id)).toMatchObject({ sentAt: NOW, attempts: 0 });
    const rows = await subscriptions();
    expect(rows.map((s) => [s.endpoint.split('/').pop(), s.lastSentAt])).toEqual([
      ['flaky', null],
      ['ok', NOW],
    ]);
  });

  it('reports the failures to onPartialFailure when another browser accepted it', async () => {
    await subscribe('https://fcm.googleapis.com/fcm/send/ok');
    await subscribe('https://fcm.googleapis.com/fcm/send/flaky-1');
    await subscribe('https://fcm.googleapis.com/fcm/send/flaky-2');
    await subscribe('https://fcm.googleapis.com/fcm/send/gone');
    const n = await queue();
    const send: PushSender = async (target) => {
      if (target.endpoint.endsWith('/gone')) throw pushError(410);
      if (target.endpoint.includes('/flaky')) throw pushError(503, 'push service busy');
    };
    const onPartialFailure = vi.fn<(failure: PushPartialFailure) => void>();

    const result = await deliver(send, onPartialFailure);

    expect(result).toEqual({ delivered: 1, failures: [] });
    // Once, with the distinct errors; a gone subscription is not a failure.
    expect(onPartialFailure).toHaveBeenCalledExactlyOnceWith({
      notificationId: n.id,
      memberId,
      accepted: 1,
      failed: 2,
      errors: ['push service busy'],
    });
  });

  it('does not report when every browser accepted it or none did', async () => {
    await subscribe('https://fcm.googleapis.com/fcm/send/ok');
    await queue();
    const onPartialFailure = vi.fn<(failure: PushPartialFailure) => void>();

    await deliver(async () => {}, onPartialFailure);
    expect(onPartialFailure).not.toHaveBeenCalled();

    await queue();
    await deliver(async () => {
      throw pushError(503);
    }, onPartialFailure);
    expect(onPartialFailure).not.toHaveBeenCalled();
  });

  it('still counts it as delivered when onPartialFailure throws', async () => {
    await subscribe('https://fcm.googleapis.com/fcm/send/ok');
    await subscribe('https://fcm.googleapis.com/fcm/send/flaky');
    const n = await queue();
    const send: PushSender = async (target) => {
      if (target.endpoint.endsWith('/flaky')) throw pushError(503);
    };

    const result = await deliver(send, () => {
      throw new Error('logger broke');
    });

    expect(result).toEqual({ delivered: 1, failures: [] });
    expect((await stored(n.id))?.sentAt).toEqual(NOW);
  });

  it('never sends to a host that is not a push service, and deletes that subscription', async () => {
    await subscribe('https://fcm.googleapis.com/fcm/send/real');
    await subscribe('https://internal.example/hook');
    await subscribe('https://fcm.googleapis.com.attacker.example/send/1');
    await subscribe('https://user:pw@fcm.googleapis.com/fcm/send/creds');
    await subscribe('http://fcm.googleapis.com/fcm/send/plain');
    const n = await queue();
    const send = vi.fn<PushSender>(async () => {});

    const result = await deliver(send);

    expect(result).toEqual({ delivered: 1, failures: [] });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].endpoint).toBe('https://fcm.googleapis.com/fcm/send/real');
    expect((await subscriptions()).map((s) => s.endpoint)).toEqual([
      'https://fcm.googleapis.com/fcm/send/real',
    ]);
    expect((await stored(n.id))?.sentAt).toEqual(NOW);
  });

  it('retries with backoff when no browser accepted it and one failed for another reason', async () => {
    await subscribe('https://fcm.googleapis.com/fcm/send/gone');
    await subscribe('https://fcm.googleapis.com/fcm/send/flaky');
    const n = await queue();
    const send: PushSender = async (target) => {
      throw target.endpoint.endsWith('/gone')
        ? pushError(410)
        : pushError(503, 'push service busy');
    };

    const result = await deliver(send);

    expect(result.delivered).toBe(0);
    expect(result.failures).toEqual([
      expect.objectContaining({
        notificationId: n.id,
        channel: 'web_push',
        attempts: 1,
        gaveUp: false,
        error: 'Web Push failed for 1 subscription: push service busy',
      }),
    ]);
    expect(await stored(n.id)).toMatchObject({ sentAt: null, attempts: 1 });
    expect((await stored(n.id))?.nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime());
    // The gone one is deleted even though the notification is retried; the flaky one is kept.
    expect((await subscriptions()).map((s) => [s.endpoint.split('/').pop(), s.lastSentAt])).toEqual(
      [['flaky', null]],
    );

    // The retry goes only to what is left, and a success then delivers it.
    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const retry = vi.fn<PushSender>(async () => {});
    const again = await deliverOutbox(db, {
      now: later,
      handlers: { web_push: createWebPushHandler(db, { send: retry, now: later }) },
    });
    expect(again).toEqual({ delivered: 1, failures: [] });
    expect(retry).toHaveBeenCalledTimes(1);
    expect((await stored(n.id))?.sentAt).toEqual(later);
  });

  it('reports every distinct failure when all browsers fail', async () => {
    await subscribe('https://fcm.googleapis.com/fcm/send/a');
    await subscribe('https://fcm.googleapis.com/fcm/send/b');
    await subscribe('https://fcm.googleapis.com/fcm/send/c');
    await queue();
    const send: PushSender = async (target) => {
      throw new Error(target.endpoint.endsWith('/c') ? 'timeout' : 'ECONNRESET');
    };

    const result = await deliver(send);

    expect(result.failures[0]?.error).toBe(
      'Web Push failed for 3 subscriptions: ECONNRESET; timeout',
    );
    expect(await subscriptions()).toHaveLength(3);
  });

  it('gives up like any other channel after the last attempt', async () => {
    await subscribe('https://fcm.googleapis.com/fcm/send/flaky');
    const n = await queue();
    const send: PushSender = async () => {
      throw pushError(500);
    };

    const result = await deliverOutbox(db, {
      now: NOW,
      maxAttempts: 1,
      handlers: { web_push: createWebPushHandler(db, { send, now: NOW }) },
    });

    expect(result.failures[0]).toMatchObject({ gaveUp: true });
    expect((await stored(n.id))?.failedAt).toEqual(NOW);
  });

  it('delivers, without sending, when every subscription turns out to be gone', async () => {
    await subscribe('https://fcm.googleapis.com/fcm/send/gone');
    const n = await queue();

    const result = await deliver(async () => {
      throw pushError(410);
    });

    expect(result).toEqual({ delivered: 1, failures: [] });
    expect(await subscriptions()).toEqual([]);
    expect((await stored(n.id))?.sentAt).toEqual(NOW);
  });

  it('delivers, without sending, when the member has no subscriptions left', async () => {
    const n = await queue();
    const send = vi.fn<PushSender>(async () => {});

    const result = await deliver(send);

    expect(result).toEqual({ delivered: 1, failures: [] });
    expect(send).not.toHaveBeenCalled();
    expect((await stored(n.id))?.sentAt).toEqual(NOW);
  });

  it('leaves other channels alone', async () => {
    await subscribe('https://fcm.googleapis.com/fcm/send/phone');
    await db.insert(notification).values({
      householdId,
      memberId,
      channel: 'in_app',
      dedupeKey: 'test:in_app',
      nextAttemptAt: NOW,
      payload: (await queue()).payload,
    });
    const send = vi.fn<PushSender>(async () => {});

    const result = await deliver(send);

    expect(result.delivered).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
