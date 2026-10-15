import {
  deliverOutboxBatches,
  findHouseholdById,
  giveUpStaleNotifications,
  type Database,
  type DeliverOutboxResult,
  type OutboxBatchHandler,
} from '@tracker/db';
import type { Api } from 'grammy';
import type { BotDeps } from './deps.js';
import { buildGroupMessage, messageOptions } from './message.js';

/*
 * Sending the reminders the worker queued for the house group (channel `telegram_group`, which
 * the worker never claims: this bot owns it). Everything that is pending for a household goes
 * out as one message, however many reminders fell due together, so the group gets one ping and
 * one set of buttons per slot instead of a message per task.
 *
 * A reminder that is long overdue by the time the bot gets to it (it was down or idle) is not
 * posted: when the bot comes back it would dump hours of stale reminders in the group in a burst.
 * Those rows are given up on instead; see `giveUpStaleNotifications`.
 *
 * Delivery is at-least-once: if the process dies between Telegram accepting the message and the
 * database recording it, the next run sends it again. A failed send (or a household whose group
 * was unlinked meanwhile) is retried with backoff and eventually given up on; see
 * `deliverOutboxBatches`.
 */

/** Sends one household's batch of reminders as one message and reports its id. */
export function groupMessageHandler(db: Database, api: Api, deps: BotDeps): OutboxBatchHandler {
  return async (notifications) => {
    // The outbox never hands over an empty batch.
    const householdId = (notifications[0] as (typeof notifications)[number]).householdId;
    const household = await findHouseholdById(db, householdId);
    if (household?.telegramGroupChatId == null) {
      throw new Error('The household has no linked Telegram group');
    }
    const message = await buildGroupMessage(db, household, notifications, { now: deps.now() });
    const sent = await api.sendMessage(
      household.telegramGroupChatId,
      message.text,
      messageOptions(message),
    );
    // The chat Telegram reports, not the one asked for: that is what a button press carries.
    return { telegramChatId: sent.chat.id, telegramMessageId: sent.message_id };
  };
}

/**
 * Gives up on reminders that are too old to post, then delivers everything that is due now, and
 * logs what happened.
 */
export async function deliverGroupMessages(
  db: Database,
  api: Api,
  deps: BotDeps,
): Promise<DeliverOutboxResult> {
  const now = deps.now();
  const channel = 'telegram_group';
  const stale = await giveUpStaleNotifications(db, { now, channel });
  if (stale > 0) deps.logger.warn('stale reminders not sent', { count: stale });
  const result = await deliverOutboxBatches(db, {
    now,
    channel,
    handler: groupMessageHandler(db, api, deps),
  });
  if (result.delivered > 0) deps.logger.info('reminders delivered', { count: result.delivered });
  for (const failure of result.failures) {
    deps.logger.warn('reminder delivery failed', { ...failure });
  }
  return result;
}
