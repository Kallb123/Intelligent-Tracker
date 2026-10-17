import { localToday } from '@tracker/core';
import {
  dueOrder,
  household,
  occurrence,
  task,
  taskAssignee,
  taskMilestone,
  type DbOrTransaction,
  type Occurrence,
  type Task,
} from '@tracker/db';
import { OPEN_OCCURRENCE_STATUSES, type OccurrenceDto, type TaskDto } from '@tracker/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { notFound } from '../errors.js';

/** The household settings the task routes depend on. */
export async function householdSettings(db: DbOrTransaction, householdId: string) {
  const [row] = await db
    .select({
      timezone: household.timezone,
      defaultReminderProfile: household.defaultReminderProfile,
    })
    .from(household)
    .where(eq(household.id, householdId));
  if (!row) throw new Error(`household ${householdId} does not exist`);
  return row;
}

/** `HH:MM:SS` from a Postgres `time` column to the `HH:MM` the api speaks. */
const trimSeconds = (time: string | null): string | null => (time ? time.slice(0, 5) : null);

/** The only shape in which a task leaves the api. */
export function toTaskDto(
  t: Task,
  assigneeIds: string[],
  milestones: TaskDto['milestones'],
  nextAssigneeId: string | null,
): TaskDto {
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    category: t.category,
    tags: t.tags,
    priority: t.priority,
    reminderSlot: t.reminderSlot,
    reminderCustomTime: trimSeconds(t.reminderCustomTime),
    effortMinutes: t.effortMinutes,
    scheduleKind: t.scheduleKind,
    allDay: t.allDay,
    dueDate: t.dueDate,
    dueAt: t.dueAt?.toISOString() ?? null,
    rrule: t.rrule,
    intervalAfterCompletionDays: t.intervalAfterCompletionDays,
    workingDaysOnly: t.workingDaysOnly,
    remindOffsetDays: t.remindOffsetDays,
    leadTimeDays: t.leadTimeDays,
    reminderProfile: t.reminderProfile,
    assignmentMode: t.assignmentMode,
    assigneeIds,
    nextAssigneeId,
    milestones,
    archived: t.archivedAt !== null,
    archivedAt: t.archivedAt?.toISOString() ?? null,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/**
 * For each of the tasks with an open occurrence, who has the earliest one: the same due order a
 * rotation is planned in (`dueOrder`, in the household's time zone), undated last.
 */
async function nextAssigneeIds(
  db: DbOrTransaction,
  taskIds: string[],
): Promise<Map<string, string | null>> {
  const rows = await db
    .selectDistinctOn([occurrence.taskId], {
      taskId: occurrence.taskId,
      assigneeId: occurrence.assigneeId,
    })
    .from(occurrence)
    .innerJoin(task, eq(task.id, occurrence.taskId))
    .innerJoin(household, eq(household.id, task.householdId))
    .where(
      and(
        inArray(occurrence.taskId, taskIds),
        inArray(occurrence.status, [...OPEN_OCCURRENCE_STATUSES]),
      ),
    )
    .orderBy(occurrence.taskId, dueOrder(household.timezone), asc(occurrence.id));
  return new Map(rows.map((row) => [row.taskId, row.assigneeId]));
}

/**
 * Task DTOs for `rows` (in that order), loading their assignees, milestones and next assignees
 * in three queries.
 */
export async function loadTaskDtos(db: DbOrTransaction, rows: Task[]): Promise<TaskDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((t) => t.id);
  const [assignees, milestones, next] = await Promise.all([
    db
      .select()
      .from(taskAssignee)
      .where(inArray(taskAssignee.taskId, ids))
      .orderBy(asc(taskAssignee.position)),
    db
      .select()
      .from(taskMilestone)
      .where(inArray(taskMilestone.taskId, ids))
      .orderBy(asc(taskMilestone.position)),
    nextAssigneeIds(db, ids),
  ]);
  return rows.map((t) =>
    toTaskDto(
      t,
      assignees.filter((a) => a.taskId === t.id).map((a) => a.memberId),
      milestones
        .filter((m) => m.taskId === t.id)
        .map((m) => ({ id: m.id, title: m.title, offsetDaysBeforeDue: m.offsetDaysBeforeDue })),
      next.get(t.id) ?? null,
    ),
  );
}

/** One task of the household as a DTO; 404 if it does not exist or belongs to another household. */
export async function loadTaskDto(
  db: DbOrTransaction,
  householdId: string,
  taskId: string,
): Promise<TaskDto> {
  const [row] = await db
    .select()
    .from(task)
    .where(and(eq(task.id, taskId), eq(task.householdId, householdId)));
  if (!row) throw notFound('No such task');
  const [dto] = await loadTaskDtos(db, [row]);
  return dto as TaskDto;
}

/** An occurrence with the few task fields shown beside it. */
export interface OccurrenceRow {
  occurrence: Occurrence;
  task: OccurrenceDto['task'];
}

/** `SELECT occurrence + its task` for the caller to add `where`/`orderBy` to. */
export function selectOccurrences(db: DbOrTransaction) {
  return db
    .select({
      occurrence,
      task: {
        title: task.title,
        category: task.category,
        priority: task.priority,
        allDay: task.allDay,
        scheduleKind: task.scheduleKind,
      },
    })
    .from(occurrence)
    .innerJoin(task, eq(task.id, occurrence.taskId));
}

/** The point in time "overdue" is judged at: the instant, and the household-local date. */
export interface OverdueClock {
  now: Date;
  timezone: string;
}

/** The only shape in which an occurrence leaves the api. */
export function toOccurrenceDto(row: OccurrenceRow, clock: OverdueClock): OccurrenceDto {
  const o = row.occurrence;
  const open = o.status === 'upcoming' || o.status === 'active' || o.status === 'started';
  const pastDue =
    (o.dueAt !== null && o.dueAt < clock.now) ||
    (o.dueDate !== null && o.dueDate < localToday(clock.now, clock.timezone));
  return {
    id: o.id,
    taskId: o.taskId,
    task: row.task,
    dueDate: o.dueDate,
    dueAt: o.dueAt?.toISOString() ?? null,
    startAt: o.startAt?.toISOString() ?? null,
    assigneeId: o.assigneeId,
    status: o.status,
    completedAt: o.completedAt?.toISOString() ?? null,
    completedBy: o.completedBy,
    snoozedUntil: o.snoozedUntil?.toISOString() ?? null,
    overdue: open && pastDue,
  };
}

/** The household's occurrences with these ids as DTOs (those that exist, in `ids` order). */
export async function loadOccurrenceDtos(
  db: DbOrTransaction,
  householdId: string,
  ids: string[],
  clock: OverdueClock,
): Promise<OccurrenceDto[]> {
  if (ids.length === 0) return [];
  const rows = await selectOccurrences(db).where(
    and(inArray(occurrence.id, ids), eq(task.householdId, householdId)),
  );
  return ids.flatMap((id) => {
    const row = rows.find((r) => r.occurrence.id === id);
    return row ? [toOccurrenceDto(row, clock)] : [];
  });
}
