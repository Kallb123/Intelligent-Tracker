import { addLocalDays } from '@tracker/core';
import {
  formatDayHeading,
  MAX_OCCURRENCE_LIMIT,
  MAX_UPCOMING_DAYS,
  type OccurrenceDto,
} from '@tracker/shared';
import { formatTime } from '../format.js';
import { dueDateOf, groupByDate } from './occurrences.js';

export type CopyBucket = 'today' | 'week' | 'undated' | 'all';

/** One `GET /api/occurrences` request that feeds a bucket. */
export interface CopyQuery {
  view: 'today' | 'upcoming';
  days?: number;
  limit: number;
}

/** Occurrences asked for per request; the api returns no more than this. */
export const COPY_LIMIT = MAX_OCCURRENCE_LIMIT;
const TODAY_VIEW: CopyQuery = { view: 'today', limit: COPY_LIMIT };

/**
 * The api requests that together hold everything a bucket needs. The today view is everything due
 * today or earlier, in its lead time, or undated; `upcoming` is from tomorrow up to `days` ahead.
 */
export function queriesFor(bucket: CopyBucket): CopyQuery[] {
  switch (bucket) {
    case 'week':
      return [TODAY_VIEW, { view: 'upcoming', days: 6, limit: COPY_LIMIT }];
    case 'all':
      return [TODAY_VIEW, { view: 'upcoming', days: MAX_UPCOMING_DAYS, limit: COPY_LIMIT }];
    default:
      return [TODAY_VIEW];
  }
}

/**
 * Whether any response came back full. It may have been cut at the limit, or may be complete: the
 * api caps `limit` at 500, so one more cannot be asked for.
 */
export function wasCut(responseSizes: readonly number[], limit = COPY_LIMIT): boolean {
  return responseSizes.some((size) => size >= limit);
}

/** Keeps the occurrences a bucket covers, once each (an item in its prep window can be in both views). */
export function selectForBucket(
  occurrences: readonly OccurrenceDto[],
  bucket: CopyBucket,
  today: string,
  timeZone: string,
): OccurrenceDto[] {
  const last = bucket === 'week' ? addLocalDays(today, 6) : today;
  const seen = new Set<string>();
  return occurrences.filter((o) => {
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    if (bucket === 'all') return true;
    const date = dueDateOf(o, timeZone);
    if (bucket === 'undated') return date === null;
    return date !== null && date <= last;
  });
}

function heading(bucket: CopyBucket, today: string): string {
  switch (bucket) {
    case 'today':
      return `Today (${formatDayHeading(today, today)})`;
    case 'week':
      return `This week (${formatDayHeading(today, today)} to ${formatDayHeading(addLocalDays(today, 6), today)})`;
    case 'undated':
      return 'Undated tasks';
    case 'all':
      return 'All tasks';
  }
}

/** Earliest due first; undated last. Stable, so the api's order breaks ties. */
function byDue(timeZone: string) {
  const key = (o: OccurrenceDto) => `${dueDateOf(o, timeZone) ?? '9999-99-99'} ${o.dueAt ?? ''}`;
  return (a: OccurrenceDto, b: OccurrenceDto) => key(a).localeCompare(key(b));
}

export interface CopyListOptions {
  bucket: CopyBucket;
  /** `YYYY-MM-DD` in the household's zone. */
  today: string;
  timeZone: string;
  /** A member id to their name, "Anyone" for none. */
  nameOf: (id: string | null) => string;
  /** The api lists may have been cut at the limit (see `wasCut`); the text then says so. */
  cut?: boolean;
}

export interface CopyList {
  /** Plain text ready to paste; empty when there is nothing. */
  text: string;
  count: number;
}

/**
 * Formats the open occurrences of a bucket as plain text for a chat or notes app: a heading, then
 * "Overdue" first, one section per due day, and "No date" last. Each line is
 * `• Title — Assignee`, with the time in brackets for a timed due and the original day for an
 * overdue item.
 */
export function buildCopyList(
  occurrences: readonly OccurrenceDto[],
  { bucket, today, timeZone, nameOf, cut = false }: CopyListOptions,
): CopyList {
  const items = selectForBucket(occurrences, bucket, today, timeZone).sort(byDue(timeZone));
  if (items.length === 0) return { text: '', count: 0 };

  const isOverdue = (o: OccurrenceDto) => {
    const date = dueDateOf(o, timeZone);
    return date !== null && (o.overdue || date < today);
  };
  const line = (o: OccurrenceDto, showDay: boolean) => {
    const date = dueDateOf(o, timeZone);
    const timed = o.dueAt && !o.task.allDay ? formatTime(o.dueAt, timeZone) : '';
    const when = [showDay && date ? `was due ${formatDayHeading(date, today)}` : '', timed];
    const extra = when.filter(Boolean).join(', ');
    return `• ${o.task.title} — ${nameOf(o.assigneeId)}${extra ? ` (${extra})` : ''}`;
  };

  const sections: string[] = [];
  const overdue = items.filter(isOverdue);
  if (overdue.length > 0) {
    sections.push(['Overdue', ...overdue.map((o) => line(o, true))].join('\n'));
  }
  for (const group of groupByDate(
    items.filter((o) => !isOverdue(o)),
    timeZone,
  )) {
    const title = group.date === null ? 'No date' : formatDayHeading(group.date, today);
    sections.push([title, ...group.occurrences.map((o) => line(o, false))].join('\n'));
  }
  if (cut)
    sections.push(`Some lists may have been cut at ${COPY_LIMIT} tasks; see the app for the rest.`);
  return { text: [heading(bucket, today), ...sections].join('\n\n'), count: items.length };
}
