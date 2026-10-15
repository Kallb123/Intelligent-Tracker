import {
  deliverOutboxBatches,
  findHouseholdById,
  type Database,
  type DeliverOutboxResult,
  type OutboxBatchHandler,
} from '@tracker/db';
import type { Api } from 'grammy';
import type { BotDeps } from './deps.js';
import { errorFields } from './logger.js';
import { buildGroupMessage, messageOptions } from './message.js';

/*
 * Sending the reminders the worker queued for the house group (channel `telegram_group`, which
 * the worker never claims: this bot owns it). Everything that is pending for a household goes
 * out as one message, however many reminders fell due together, so the group gets one ping and
 * one set of buttons per slot instead of a message per task.
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
    return { telegramMessageId: sent.message_id };
  };
}

/** Delivers everything that is due now and logs what happened. */
export async function deliverGroupMessages(
  db: Database,
  api: Api,
  deps: BotDeps,
): Promise<DeliverOutboxResult> {
  const result = await deliverOutboxBatches(db, {
    now: deps.now(),
    channel: 'telegram_group',
    handler: groupMessageHandler(db, api, deps),
  });
  if (result.delivered > 0) deps.logger.info('reminders delivered', { count: result.delivered });
  for (const failure of result.failures) {
    deps.logger.warn('reminder delivery failed', { ...failure });
  }
  return result;
}

export interface DeliveryLoop {
  /** Stops scheduling and resolves once any run in progress has finished. */
  stop(): Promise<void>;
}

/**
 * Delivers right away and then `intervalMs` after each run finishes (a timeout chain, not an
 * interval), so runs never overlap however long one takes, and a failed run is logged and tried
 * again on the next one.
 */
export function startDeliveryLoop(
  db: Database,
  api: Api,
  deps: BotDeps,
  intervalMs: number,
): DeliveryLoop {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const run = (): void => {
    timer = undefined;
    inFlight = (async () => {
      try {
        await deliverGroupMessages(db, api, deps);
      } catch (error) {
        deps.logger.error('delivery run failed', errorFields(error));
      }
      if (!stopped) timer = setTimeout(run, intervalMs);
    })();
  };
  run();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
