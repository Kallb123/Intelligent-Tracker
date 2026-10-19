import { createHash } from 'node:crypto';
import { analyseHistory } from '@tracker/core';
import type { SuggestionAction, SuggestionDto } from '@tracker/shared';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database, DbOrTransaction } from './client.js';
import { reassignOpenOccurrences, rematerialiseTask } from './materialise.js';
import { activity, household, member, occurrence, task, taskAssignee } from './schema/index.js';

const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40);

/** Computed from current history; never writes on a GET. Resolutions live in the activity log. */
async function candidates(db: DbOrTransaction, householdId: string, now: Date, taskId?: string) {
  const tasks = await db
    .select()
    .from(task)
    .where(
      and(
        eq(task.householdId, householdId),
        isNull(task.archivedAt),
        taskId ? eq(task.id, taskId) : undefined,
      ),
    )
    .orderBy(asc(task.id));
  if (tasks.length === 0) return [];
  const ids = tasks.map((t) => t.id);
  const [settings] = await db.select().from(household).where(eq(household.id, householdId));
  if (!settings) return [];
  const assignees = await db
    .select({
      taskId: taskAssignee.taskId,
      id: member.id,
      name: member.name,
      awayUntil: member.awayUntil,
    })
    .from(taskAssignee)
    .innerJoin(member, eq(member.id, taskAssignee.memberId))
    .where(and(inArray(taskAssignee.taskId, ids), eq(member.householdId, householdId)))
    .orderBy(asc(taskAssignee.position));
  // Rank in SQL, so old series don't pull their entire history into the process. Completion
  // events identify actual actions; the occurrence supplies its preserved due and completer.
  const ranked = db
    .select({
      id: occurrence.id,
      taskId: occurrence.taskId,
      dueDate: occurrence.dueDate,
      dueAt: occurrence.dueAt,
      completedAt: occurrence.completedAt,
      completedBy: occurrence.completedBy,
      rank: sql<number>`row_number() over (partition by ${occurrence.taskId} order by ${occurrence.completedAt} desc, ${occurrence.id})`.as(
        'rank',
      ),
    })
    .from(occurrence)
    .where(
      and(
        inArray(occurrence.taskId, ids),
        eq(occurrence.status, 'done'),
        lte(occurrence.completedAt, now),
        inArray(
          occurrence.id,
          db
            .select({ id: activity.occurrenceId })
            .from(activity)
            .where(
              and(eq(activity.householdId, householdId), eq(activity.kind, 'occurrence.completed')),
            ),
        ),
      ),
    )
    .as('history');
  const history = await db.select().from(ranked).where(lte(ranked.rank, 20));
  const snooze = alias(activity, 'snooze');
  const snoozes =
    history.length === 0
      ? []
      : await db
          .select({
            occurrenceId: snooze.occurrenceId,
            count: sql<number>`count(*)::int`,
          })
          .from(snooze)
          .where(
            and(
              eq(snooze.householdId, householdId),
              eq(snooze.kind, 'occurrence.snoozed'),
              inArray(
                snooze.occurrenceId,
                history.map((c) => c.id),
              ),
              lte(snooze.createdAt, now),
            ),
          )
          .groupBy(snooze.occurrenceId);
  const resolved = await db
    .select({ data: activity.data })
    .from(activity)
    .where(
      and(
        eq(activity.householdId, householdId),
        inArray(activity.taskId, ids),
        inArray(activity.kind, ['suggestion.accepted', 'suggestion.dismissed']),
      ),
    );
  const evidence = new Set(resolved.map((r) => r.data['evidenceKey']));

  return tasks.flatMap((t) => {
    const members = assignees.filter((a) => a.taskId === t.id);
    const proposals = analyseHistory({
      now,
      timezone: settings.timezone,
      task: t,
      assignees: members,
      completions: history
        .filter((c) => c.taskId === t.id && c.completedAt !== null)
        .map((c) => ({
          ...c,
          completedAt: c.completedAt!,
          snoozes: snoozes.find((s) => s.occurrenceId === c.id)?.count ?? 0,
        })),
    });
    return proposals.flatMap((p) => {
      const evidenceKey = fingerprint([t.id, p.kind, p.evidence]);
      if (evidence.has(evidenceKey)) return [];
      // Any task edit invalidates cards already displayed, including cross-channel cards.
      const id = fingerprint([evidenceKey, t.updatedAt, members, settings.timezone, p]);
      return [
        {
          id,
          taskId: t.id,
          title: t.title,
          kind: p.kind,
          message: p.message,
          evidenceKey,
          patch: p.patch,
        },
      ];
    });
  });
}

function dto(row: Awaited<ReturnType<typeof candidates>>[number]): SuggestionDto {
  const { id, taskId, title, kind, message } = row;
  return { id, taskId, title, kind, message };
}

export async function listSuggestions(
  db: DbOrTransaction,
  householdId: string,
  now: Date,
): Promise<SuggestionDto[]> {
  return (await candidates(db, householdId, now)).map(dto);
}

/**
 * Recomputes under the same task lock as task/occurrence writers. Exactly one concurrent press
 * can act; a stale, resolved, archived, deleted or other-household card returns false. Neither
 * interface accepts a client-provided patch. Changes and their audit entry commit together.
 */
export async function resolveSuggestion(
  db: Database,
  input: {
    householdId: string;
    memberId: string;
    id: string;
    action: SuggestionAction;
    now: Date;
  },
): Promise<boolean> {
  const { householdId, memberId, id, action, now } = input;
  const shown = (await candidates(db, householdId, now)).find((s) => s.id === id);
  if (!shown) return false;
  return db.transaction(async (tx) => {
    // Recheck the actor too: this helper is shared by the API and Telegram.
    const [actor] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.id, memberId), eq(member.householdId, householdId)));
    if (!actor) return false;
    await tx
      .select({ id: task.id })
      .from(task)
      .where(and(eq(task.id, shown.taskId), eq(task.householdId, householdId)))
      .for('no key update');
    const current = (await candidates(tx, householdId, now, shown.taskId)).find((s) => s.id === id);
    if (!current) return false;
    if (action === 'accept') {
      await tx.update(task).set(current.patch).where(eq(task.id, current.taskId));
      if (current.patch.leadTimeDays !== undefined) {
        await rematerialiseTask(tx, current.taskId, { now, keepDues: true });
      }
      if (current.patch.rotationCursor !== undefined) {
        await reassignOpenOccurrences(tx, current.taskId, { now });
      }
      // The worker detects changed reminder inputs and replans slot/lead/assignee changes.
    }
    await tx.insert(activity).values({
      householdId,
      memberId,
      taskId: current.taskId,
      createdAt: now,
      kind: action === 'accept' ? 'suggestion.accepted' : 'suggestion.dismissed',
      data: {
        suggestionId: id,
        evidenceKey: current.evidenceKey,
        kind: current.kind,
        ...(action === 'accept' ? { patch: current.patch } : {}),
      },
    });
    return true;
  });
}
