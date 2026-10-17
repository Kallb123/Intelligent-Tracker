import { dueDigests } from '@tracker/core';
import {
  claimDigest,
  linkedHouseholds,
  loadAgenda,
  recordDigestMessage,
  releaseDigest,
  type Database,
  type Household,
} from '@tracker/db';
import type { DigestKind } from '@tracker/shared';
import type { Api } from 'grammy';
import type { BotDeps } from './deps.js';
import { renderMorningDigest, renderWeekAhead } from './digest.js';
import { errorFields } from './logger.js';

/*
 * Sending the scheduled digests to the house group: the morning digest every day at the morning
 * slot and the "week ahead" on Sundays at the evening slot (`dueDigests` says which are in their
 * window). Unlike reminders they do not come from the outbox: the agenda is built when the
 * digest is sent, so it is as fresh as it can be, and `telegram_digest` is the log that makes
 * each go out once per household and day.
 *
 * A digest is claimed before it is built, and a claim is kept when there is nothing to say (a
 * digest for an empty day is not sent, and not looked at again on every tick). If the send fails
 * the claim is given back and the next tick tries again, until the window closes. Delivery is
 * at-most-once otherwise: if the process dies between claiming and sending, that digest is
 * missed, which is better than posting it twice in the group.
 */

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
        if (!(await claimDigest(db, { ...key, now }))) continue;
        try {
          const text = await digestText[kind](db, household, now);
          if (text === null) continue;
          const message = await api.sendMessage(household.telegramGroupChatId as number, text, {
            link_preview_options: { is_disabled: true },
          });
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
        } catch (error) {
          await releaseDigest(db, key);
          logger.warn('digest not sent', { ...key, ...errorFields(error) });
        }
      }
    } catch (error) {
      logger.error('digests failed', { householdId: household.id, ...errorFields(error) });
    }
  }
  return sent;
}
