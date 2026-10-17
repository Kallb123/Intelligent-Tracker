import { snoozeOptions } from '@tracker/core';
import {
  findMembersByIds,
  occurrenceStates,
  type Database,
  type Household,
  type Notification,
} from '@tracker/db';
import { instantToWall, type ReminderPayload } from '@tracker/shared';
import { renderMessage, snoozeChoices, type RenderedMessage, type RenderLine } from './render.js';

/**
 * Renders the group message that carries `notifications`, from the state of the database now:
 * who each reminder is for (and whether they can be mentioned), where each occurrence stands and
 * who got it there. This is the I/O half of `renderMessage`; it is used both to send a message
 * and to redraw it after a button press. `snoozeFor` opens that occurrence's snooze choices.
 */
export async function buildGroupMessage(
  db: Database,
  household: Household,
  notifications: Notification[],
  options: { now: Date; snoozeFor?: string },
): Promise<RenderedMessage> {
  const { now, snoozeFor } = options;
  const payloads = notifications.map((n) => n.payload);
  const distinct = <T>(values: T[]): T[] => [...new Set(values)];

  const assigneeIds = distinct(payloads.flatMap((p) => (p.assigneeId ? [p.assigneeId] : [])));
  const [members, states] = await Promise.all([
    findMembersByIds(db, household.id, assigneeIds),
    occurrenceStates(db, household.id, distinct(payloads.map((p) => p.occurrenceId))),
  ]);
  const memberById = new Map(members.map((m) => [m.id, m]));

  const lines: RenderLine[] = payloads.map((payload) => {
    if (!payload.assigneeId) return { payload, assignee: null };
    const assignee = memberById.get(payload.assigneeId);
    // The assignee was deleted since the reminder was queued.
    return {
      payload,
      assignee: assignee
        ? { name: assignee.name, telegramUserId: assignee.telegramUserId }
        : { name: 'Someone', telegramUserId: null },
    };
  });

  return renderMessage({
    lines,
    tonightsJobs: isEveningBatch(payloads[0], household),
    states: new Map(states.map((s) => [s.occurrenceId, s])),
    timeZone: household.timezone,
    now,
    ...(snoozeFor
      ? {
          snoozeMenu: {
            occurrenceId: snoozeFor,
            choices: snoozeChoices(
              snoozeOptions({
                now,
                timezone: household.timezone,
                eveningSlot: household.eveningSlot,
              }),
            ),
          },
        }
      : {}),
  });
}

/**
 * Whether the reminders fired at the household's evening slot, which makes the message its
 * "Tonight's jobs". They were queued as one batch for one slot, so the first says it for all.
 */
function isEveningBatch(first: ReminderPayload | undefined, household: Household): boolean {
  return (
    first !== undefined &&
    instantToWall(first.fireAt, household.timezone).time === household.eveningSlot.slice(0, 5)
  );
}

/** The options that send or edit a message as rendered: HTML, no link preview, its keyboard. */
export function messageOptions({ keyboard }: RenderedMessage) {
  return {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: keyboard },
  } as const;
}
