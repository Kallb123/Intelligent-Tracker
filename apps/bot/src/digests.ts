import { dueDigests } from '@tracker/core';
import {
  claimDigest,
  linkedHouseholds,
  loadAgenda,
  recordDigestMessage,
  releaseDigest,
  type Database,
  type DigestKey,
  type Household,
} from '@tracker/db';
import type { DigestKind } from '@tracker/shared';
import { GrammyError, type Api } from 'grammy';
import type { BotDeps } from './deps.js';
import { renderMorningDigest, renderWeekAhead } from './digest.js';
import { errorFields } from './logger.js';
import { NO_PREVIEW } from './sender.js';

/*
 * Sending the scheduled digests to the house group: the morning digest every day at the morning
 * slot and the "week ahead" on Sundays at the evening slot (`dueDigests` says which are in their
 * window). Unlike reminders they do not come from the outbox: the agenda is built when the
 * digest is sent, so it is as fresh as it can be, and `telegram_digest` is the log that makes
 * each go out once per household and day.
 *
 * A digest is claimed before it is built, and a claim is kept when there is nothing to say (a
 * digest for an empty day is not sent, and not looked at again on every tick). The claim is given
 * back, so the next tick tries again until the window closes, when the digest could not be built
 * or Telegram answered that it is busy or failing (429, 5xx). A 429 says how long to wait
 * (`retry_after`); the digest is not tried again before then, so the ticks in between do not
 * hammer a rate limit. That wait is only remembered in memory: a restart forgets it, which at
 * worst costs one early retry. Delivery is at-most-once
 * otherwise, which is better than posting a digest twice in the group: the claim stays when
 * Telegram refused for good (the bot was removed from the group, say: retrying all morning
 * would not help), when the request failed in a way that does not say whether Telegram took the
 * message (a timeout), and when the process dies between claiming and sending.
 */

/** Telegram answered, and the failure is on its side or a matter of timing: worth retrying. */
const retryable = (error: GrammyError): boolean =>
  error.error_code === 429 || error.error_code >= 500;

/** How long to wait after a 429 that does not say (Telegram always does, in practice). */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/** Per digest (see `backoffKey`), when it may next be tried, as epoch milliseconds. */
const notBefore = new Map<string, number>();

const backoffKey = ({ householdId, kind, localDate }: DigestKey): string =>
  `${householdId}/${kind}/${localDate}`;

/** Forgets every wait; for tests, which share the process (and so this map). */
export function resetDigestBackoff(): void {
  notBefore.clear();
}

const digestText = {
  morning: async (db: Database, household: Household, now: Date) =>
    renderMorningDigest(
      await loadAgenda(db, household, { now, view: 'today' }),
      household.timezone,
    ),
  week_ahead: async (db: Database, household: Household, now: Date) =>
    renderWeekAhead(await loadAgenda(db, household, { now, view: 'week' }), household.timezone),
} satisfies Record<DigestKind, unknown>;

/**
 * Sends the digests that are due now to every household with a linked group, and returns how
 * many were sent. One household failing does not stop the others.
 */
export async function deliverDigests(db: Database, api: Api, deps: BotDeps): Promise<number> {
  const { logger } = deps;
  const now = deps.now();
  let sent = 0;
  // Waits that are over are forgotten, so the map does not grow with every day.
  for (const [key, until] of notBefore) if (until <= now.getTime()) notBefore.delete(key);
  for (const household of await linkedHouseholds(db)) {
    try {
      const due = dueDigests({
        now,
        timezone: household.timezone,
        morningSlot: household.morningSlot,
        eveningSlot: household.eveningSlot,
      });
      for (const { kind, localDate } of due) {
        const key = { householdId: household.id, kind, localDate };
        if (notBefore.has(backoffKey(key))) continue;
        if (!(await claimDigest(db, { ...key, now }))) continue;
        let text: string | null;
        try {
          text = await digestText[kind](db, household, now);
        } catch (error) {
          await releaseDigest(db, key);
          logger.warn('digest not built', { ...key, ...errorFields(error) });
          continue;
        }
        if (text === null) continue;
        let message;
        try {
          message = await api.sendMessage(
            household.telegramGroupChatId as number,
            text,
            NO_PREVIEW,
          );
        } catch (error) {
          if (error instanceof GrammyError && retryable(error)) {
            await releaseDigest(db, key);
            if (error.error_code === 429) {
              const seconds = error.parameters.retry_after ?? DEFAULT_RETRY_AFTER_SECONDS;
              notBefore.set(backoffKey(key), now.getTime() + seconds * 1000);
            }
            logger.warn('digest not sent, will retry', { ...key, ...errorFields(error) });
          } else if (error instanceof GrammyError) {
            logger.warn('digest refused, giving up for today', { ...key, ...errorFields(error) });
          } else {
            logger.warn('digest may not have been sent, not retrying', {
              ...key,
              ...errorFields(error),
            });
          }
          continue;
        }
        sent += 1;
        logger.info('digest sent', { householdId: household.id, kind, localDate });
        // Telegram has the message; the claim stays whether or not this note of it is saved.
        await recordDigestMessage(db, {
          ...key,
          telegramChatId: message.chat.id,
          telegramMessageId: message.message_id,
        }).catch((error: unknown) =>
          logger.warn('digest message not recorded', { ...key, ...errorFields(error) }),
        );
      }
    } catch (error) {
      logger.error('digests failed', { householdId: household.id, ...errorFields(error) });
    }
  }
  return sent;
}
