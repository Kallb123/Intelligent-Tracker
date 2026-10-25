import { localToday } from '@tracker/core';
import {
  completedMilestoneIds,
  dueInstant,
  dueOrder,
  isPastDue,
  household,
  occurrence,
  task,
  taskAssignee,
  taskMilestone,
  type DbOrTransaction,
  type Occurrence,
  type Task,
  type TaskMilestone,
} from '@tracker/db';
import {
  OPEN_OCCURRENCE_STATUSES,
  type MilestoneDto,
  type OccurrenceDto,
  type TaskDto,
} from '@tracker/shared';
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

function toMilestoneDto(m: TaskMilestone): MilestoneDto {
  return { id: m.id, title: m.title, offsetDaysBeforeDue: m.offsetDaysBeforeDue };
}

/** The milestones of these tasks, in position order. */
function selectMilestones(db: DbOrTransaction, taskIds: string[]): Promise<TaskMilestone[]> {
  return db
    .select()
    .from(taskMilestone)
    .where(inArray(taskMilestone.taskId, taskIds))
    .orderBy(asc(taskMilestone.position));
}

/** The only shape in which a task leaves the api. */
export function toTaskDto(
  t: Task,
  assigneeIds: string[],
  milestones: TaskMilestone[],
  next: NextOpenOccurrence | undefined,
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
    nextAssigneeId: next?.assigneeId ?? null,
    nextDue: next?.due ?? null,
    milestones: milestones.map(toMilestoneDto),
    nextCompletedMilestoneIds: next?.completedMilestoneIds ?? [],
    archived: t.archivedAt !== null,
    archivedAt: t.archivedAt?.toISOString() ?? null,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/**
 * The earliest open occurrence of a task: who has it, when it is due (ISO instant) and which of
 * the task's milestones are ticked on it.
 */
export interface NextOpenOccurrence {
  assigneeId: string | null;
  due: string | null;
  completedMilestoneIds: string[];
}

/**
 * For each of the tasks with an open occurrence, its earliest one: the same due order a rotation
 * is planned in (`dueOrder`, in the household's time zone), undated last. The due is the
 * occurrence's due instant (`dueInstant`), `null` when undated.
 */
async function nextOpenOccurrences(
  db: DbOrTransaction,
  taskIds: string[],
): Promise<Map<string, NextOpenOccurrence>> {
  const rows = await db
    .selectDistinctOn([occurrence.taskId], {
      taskId: occurrence.taskId,
      assigneeId: occurrence.assigneeId,
      due: dueInstant(household.timezone).mapWith(occurrence.dueAt),
      milestoneProgress: occurrence.milestoneProgress,
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
  return new Map(
    rows.map((row) => [
      row.taskId,
      {
        assigneeId: row.assigneeId,
        due: row.due?.toISOString() ?? null,
        completedMilestoneIds: completedMilestoneIds(row.milestoneProgress),
      },
    ]),
  );
}

/**
 * Task DTOs for `rows` (in that order), loading their assignees, milestones and next open occurrences
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
    selectMilestones(db, ids),
    nextOpenOccurrences(db, ids),
  ]);
  return rows.map((t) =>
    toTaskDto(
      t,
      assignees.filter((a) => a.taskId === t.id).map((a) => a.memberId),
      milestones.filter((m) => m.taskId === t.id),
      next.get(t.id),
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

/**
 * The only shape in which an occurrence leaves the api. `taskMilestones` are its task's
 * milestones in position order; the occurrence says which of them are ticked.
 */
export function toOccurrenceDto(
  row: OccurrenceRow,
  clock: OverdueClock,
  taskMilestones: TaskMilestone[],
): OccurrenceDto {
  const o = row.occurrence;
  const done = new Set(completedMilestoneIds(o.milestoneProgress));
  const open = o.status === 'upcoming' || o.status === 'active' || o.status === 'started';
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
    milestones: taskMilestones.map((m) => ({ ...toMilestoneDto(m), done: done.has(m.id) })),
    overdue: open && isPastDue(o, clock.now, localToday(clock.now, clock.timezone)),
  };
}

/** DTOs for `rows` (in that order), loading their tasks' milestones in one query. */
export async function toOccurrenceDtos(
  db: DbOrTransaction,
  rows: OccurrenceRow[],
  clock: OverdueClock,
): Promise<OccurrenceDto[]> {
  if (rows.length === 0) return [];
  const milestones = await selectMilestones(db, [...new Set(rows.map((r) => r.occurrence.taskId))]);
  return rows.map((row) =>
    toOccurrenceDto(
      row,
      clock,
      milestones.filter((m) => m.taskId === row.occurrence.taskId),
    ),
  );
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
  const ordered = ids.flatMap((id) => rows.find((r) => r.occurrence.id === id) ?? []);
  return toOccurrenceDtos(db, ordered, clock);
}
