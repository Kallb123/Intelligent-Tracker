import {
  createDb,
  household,
  member,
  notification,
  occurrence,
  runMigrations,
  task,
  type Database,
  type DbHandle,
} from '@tracker/db';
import { createTestDatabase, type TestDatabase } from '@tracker/db/test-db';
import type { ReminderPayload } from '@tracker/shared';
import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createBot, type CreateBotOptions } from './bot.js';
import type { Logger } from './logger.js';

/*
 * Helpers for the bot's integration tests: a throwaway Postgres database, a fake Telegram API
 * that records every call the bot makes, builders for the updates Telegram would send, and
 * seeding of a household with a linked group, members and queued reminders.
 */

/** Needs a Postgres server: set TEST_DATABASE_URL (any database on it, e.g. .../postgres). */
export const adminUrl = process.env['TEST_DATABASE_URL'];

/** A Monday, 18:00 in London (GMT), an hour before the default evening slot. */
export const NOW = new Date('2026-11-02T18:00:00Z');
export const CHAT_ID = -1_001_234_567_890;

/** Call inside a `describe`: creates a migrated database for the suite and empties it per test. */
export function useTestDatabase(): { readonly db: Database } {
  let testDb: TestDatabase;
  let handle: DbHandle;
  beforeAll(async () => {
    testDb = await createTestDatabase(adminUrl as string);
    await runMigrations({ databaseUrl: testDb.url });
    handle = createDb(testDb.url);
  });
  afterAll(async () => {
    await handle?.close();
    await testDb?.drop();
  });
  // The household delete cascades to everything that belongs to it.
  beforeEach(async () => {
    await handle.db.delete(household);
  });
  return {
    get db() {
      return handle.db;
    },
  };
}

export interface TelegramCall {
  method: string;
  payload: Record<string, unknown>;
}

/** Makes the next call of `method` fail the way the Bot API does. */
export interface ApiFailure {
  error_code: number;
  description: string;
}

/**
 * A stand-in for the Bot API: answers every call with a plausible result and records it, so
 * tests assert on what the bot asked Telegram to do. Install it before feeding updates.
 */
export class FakeTelegram {
  readonly calls: TelegramCall[] = [];
  private readonly failures: { method: string; failure: ApiFailure }[] = [];
  private nextMessageId = 1000;

  install(bot: Bot): void {
    bot.api.config.use(async (_prev, method, payload) => {
      this.calls.push({ method, payload: payload as Record<string, unknown> });
      const index = this.failures.findIndex((f) => f.method === method);
      const failure = index >= 0 ? this.failures.splice(index, 1)[0]?.failure : undefined;
      if (failure) return { ok: false, ...failure };
      if (method === 'sendMessage') {
        const { chat_id: chatId, text } = payload as { chat_id: number; text: string };
        this.nextMessageId += 1;
        return {
          ok: true,
          result: {
            message_id: this.nextMessageId,
            date: Math.floor(NOW.getTime() / 1000),
            chat: { id: chatId, type: 'supergroup', title: 'House' },
            text,
          },
        } as never;
      }
      return { ok: true, result: true } as never;
    });
  }

  failNext(method: string, failure: ApiFailure = { error_code: 500, description: 'boom' }): void {
    this.failures.push({ method, failure });
  }

  /** The recorded payloads of one method, oldest first. */
  to(method: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.payload);
  }

  /** The text of the replies sent so far (`sendMessage`), oldest first. */
  get sentTexts(): string[] {
    return this.to('sendMessage').map((p) => p['text'] as string);
  }

  clear(): void {
    this.calls.length = 0;
  }
}

export const BOT_INFO: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: 'Tracker',
  username: 'tracker_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export interface TestLogger extends Logger {
  readonly errors: string[];
  readonly warnings: string[];
}

export function testLogger(): TestLogger {
  const errors: string[] = [];
  const warnings: string[] = [];
  return {
    errors,
    warnings,
    info() {},
    warn: (msg) => void warnings.push(msg),
    error: (msg) => void errors.push(msg),
  };
}

/** A bot on `db` whose Telegram API is fake and whose clock is pinned to `NOW`. */
export function newTestBot(
  db: Database,
  options: Partial<CreateBotOptions> = {},
): { bot: Bot; telegram: FakeTelegram; logger: TestLogger } {
  const logger = testLogger();
  const bot = createBot(db, {
    token: '123:test',
    botInfo: BOT_INFO,
    now: () => NOW,
    logger,
    ...options,
  });
  const telegram = new FakeTelegram();
  telegram.install(bot);
  return { bot, telegram, logger };
}

let updateId = 0;

/** A text message with a command, as Telegram sends it. */
export function commandUpdate(options: {
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup';
  fromId: number;
  text: string;
}): Update {
  updateId += 1;
  const command = options.text.split(' ')[0] as string;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(NOW.getTime() / 1000),
      chat: { id: options.chatId, type: options.chatType } as never,
      from: { id: options.fromId, is_bot: false, first_name: 'Someone' },
      text: options.text,
      entities: [{ type: 'bot_command', offset: 0, length: command.length }],
    },
  };
}

/** The service message sent to the old chat when a group becomes a supergroup. */
export function migrateUpdate(oldChatId: number, newChatId: number): Update {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(NOW.getTime() / 1000),
      chat: { id: oldChatId, type: 'group', title: 'House' },
      from: { id: 1, is_bot: false, first_name: 'Telegram' },
      migrate_to_chat_id: newChatId,
    },
  };
}

/** A press of an inline button on one of the bot's messages. */
export function pressUpdate(options: {
  chatId: number;
  messageId: number;
  fromId: number;
  data: string;
}): Update {
  updateId += 1;
  return {
    update_id: updateId,
    callback_query: {
      id: `query-${updateId}`,
      chat_instance: 'instance',
      from: { id: options.fromId, is_bot: false, first_name: 'Someone' },
      data: options.data,
      message: {
        message_id: options.messageId,
        date: Math.floor(NOW.getTime() / 1000),
        chat: { id: options.chatId, type: 'supergroup', title: 'House' },
        from: BOT_INFO,
        text: 'reminder',
      },
    },
  };
}

/** A household whose group is linked, for tests that start from a working setup. */
export async function newHousehold(
  db: Database,
  values: Partial<typeof household.$inferInsert> = {},
) {
  const [h] = await db
    .insert(household)
    .values({ name: 'The Smiths', telegramGroupChatId: CHAT_ID, ...values })
    .returning();
  if (!h) throw new Error('insert failed');
  return h;
}

let memberSeq = 0;

export async function newMember(
  db: Database,
  householdId: string,
  name: string,
  telegramUserId: number | null = null,
) {
  memberSeq += 1;
  const [m] = await db
    .insert(member)
    .values({ householdId, name, username: `${name.toLowerCase()}${memberSeq}`, telegramUserId })
    .returning();
  if (!m) throw new Error('insert failed');
  return m;
}

/** An open occurrence of a new one-off task, due on `dueDate`. */
export async function newOccurrence(
  db: Database,
  householdId: string,
  title: string,
  options: { assigneeId?: string | null; dueDate?: string } = {},
) {
  const dueDate = options.dueDate ?? '2026-11-02';
  const [t] = await db
    .insert(task)
    .values({ householdId, title, scheduleKind: 'once', dueDate })
    .returning();
  if (!t) throw new Error('insert failed');
  const [o] = await db
    .insert(occurrence)
    .values({ taskId: t.id, dueDate, status: 'active', assigneeId: options.assigneeId ?? null })
    .returning();
  if (!o) throw new Error('insert failed');
  return { task: t, occurrence: o };
}

let reminderSeq = 0;

/** Queues a `telegram_group` reminder for the occurrence, as the worker does when it is due. */
export async function queueGroupReminder(
  db: Database,
  householdId: string,
  occ: Awaited<ReturnType<typeof newOccurrence>>,
  overrides: Partial<ReminderPayload> = {},
) {
  reminderSeq += 1;
  const payload: ReminderPayload = {
    type: 'reminder',
    kind: 'due',
    taskId: occ.task.id,
    occurrenceId: occ.occurrence.id,
    taskTitle: occ.task.title,
    dueDate: occ.occurrence.dueDate,
    dueAt: null,
    fireAt: '2026-11-02T18:00:00Z',
    assigneeId: occ.occurrence.assigneeId,
    ...overrides,
  };
  const [n] = await db
    .insert(notification)
    .values({
      householdId,
      channel: 'telegram_group',
      payload,
      dedupeKey: `test-${reminderSeq}`,
      // Oldest first, in the order queued.
      nextAttemptAt: new Date(NOW.getTime() - 60_000 + reminderSeq),
    })
    .returning();
  if (!n) throw new Error('insert failed');
  return n;
}
