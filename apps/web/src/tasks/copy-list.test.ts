import type { OccurrenceDto } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import {
  buildCopyList,
  queriesFor,
  selectForBucket,
  wasCut,
  type CopyListOptions,
} from './copy-list.js';

const TZ = 'Europe/London';
const TODAY = '2026-10-11'; // Sunday
const names: Record<string, string> = { a: 'Alex', s: 'Sam' };
const nameOf = (id: string | null) => (id ? names[id] : undefined) ?? 'Anyone';

let n = 0;
function occ(title: string, overrides: Partial<OccurrenceDto> = {}): OccurrenceDto {
  n += 1;
  return {
    id: `id-${n}`,
    taskId: 't',
    task: { title, category: null, priority: 0, allDay: true, scheduleKind: 'fixed' },
    dueDate: TODAY,
    dueAt: null,
    startAt: null,
    assigneeId: null,
    status: 'active',
    completedAt: null,
    completedBy: null,
    snoozedUntil: null,
    milestones: [],
    overdue: false,
    ...overrides,
  } as OccurrenceDto;
}

const options = (bucket: CopyListOptions['bucket']): CopyListOptions => ({
  bucket,
  today: TODAY,
  timeZone: TZ,
  nameOf,
});

const overdue = occ('File the tax return', {
  dueDate: '2026-10-05',
  overdue: true,
  assigneeId: 's',
});
const today = occ('Put the bins out', { assigneeId: 'a' });
const tomorrow = occ('Water the plants', { dueDate: '2026-10-12', assigneeId: 's' });
const edge = occ('Dentist', { dueDate: '2026-10-17' });
const later = occ('Boiler service', { dueDate: '2026-10-18' });
const undated = occ('Sort the loft', { dueDate: null });
const all = [undated, later, edge, tomorrow, today, overdue];

describe('queriesFor', () => {
  it('asks for what each bucket needs', () => {
    expect(queriesFor('today')).toEqual([{ view: 'today', limit: 500 }]);
    expect(queriesFor('undated')).toEqual([{ view: 'today', limit: 500 }]);
    expect(queriesFor('week')).toEqual([
      { view: 'today', limit: 500 },
      { view: 'upcoming', days: 6, limit: 500 },
    ]);
    expect(queriesFor('all')).toEqual([
      { view: 'today', limit: 500 },
      { view: 'upcoming', days: 366, limit: 500 },
    ]);
  });
});

describe('selectForBucket', () => {
  const titles = (bucket: CopyListOptions['bucket']) =>
    selectForBucket(all, bucket, TODAY, TZ).map((o) => o.task.title);

  it('today: overdue and due today, no undated or future', () => {
    expect(titles('today')).toEqual(['Put the bins out', 'File the tax return']);
  });
  it('week: through today + 6', () => {
    expect(titles('week')).toEqual([
      'Dentist',
      'Water the plants',
      'Put the bins out',
      'File the tax return',
    ]);
  });
  it('undated: only those without a date', () => {
    expect(titles('undated')).toEqual(['Sort the loft']);
  });
  it('all: everything', () => {
    expect(titles('all')).toHaveLength(6);
  });
  it('drops duplicates from overlapping views', () => {
    expect(selectForBucket([today, today], 'all', TODAY, TZ)).toEqual([today]);
  });
  it('dates a timed occurrence in the household zone', () => {
    // 23:30 UTC on the 11th is 00:30 on the 12th in London (BST).
    const late = occ('Late', { dueDate: null, dueAt: '2026-10-11T23:30:00.000Z' });
    expect(selectForBucket([late], 'today', TODAY, TZ)).toEqual([]);
    expect(selectForBucket([late], 'week', TODAY, TZ)).toEqual([late]);
  });
});

describe('buildCopyList', () => {
  it('is empty when nothing matches', () => {
    expect(buildCopyList([], options('today'))).toEqual({ text: '', count: 0 });
    expect(buildCopyList([undated], options('today'))).toEqual({ text: '', count: 0 });
  });

  it('formats a day with assignees', () => {
    expect(buildCopyList([today, occ('Post', { assigneeId: null })], options('today'))).toEqual({
      text: 'Today (Sun 11 Oct)\n\nSun 11 Oct\n• Put the bins out — Alex\n• Post — Anyone',
      count: 2,
    });
  });

  it('puts overdue first and undated last, with days in order', () => {
    const { text, count } = buildCopyList(all, options('all'));
    expect(count).toBe(6);
    expect(text).toBe(
      [
        'All tasks',
        'Overdue\n• File the tax return — Sam (was due Mon 5 Oct)',
        'Sun 11 Oct\n• Put the bins out — Alex',
        'Mon 12 Oct\n• Water the plants — Sam',
        'Sat 17 Oct\n• Dentist — Anyone',
        'Sun 18 Oct\n• Boiler service — Anyone',
        'No date\n• Sort the loft — Anyone',
      ].join('\n\n'),
    );
  });

  it('heads the week with its range and the undated list plainly', () => {
    expect(buildCopyList([edge], options('week')).text.split('\n')[0]).toBe(
      'This week (Sun 11 Oct to Sat 17 Oct)',
    );
    expect(buildCopyList([undated], options('undated')).text).toBe(
      'Undated tasks\n\nNo date\n• Sort the loft — Anyone',
    );
  });

  it('appends the time for timed dues, and the day for overdue ones', () => {
    const timed = occ('Call the plumber', {
      dueDate: null,
      dueAt: '2026-10-11T13:30:00.000Z',
      task: {
        title: 'Call the plumber',
        category: null,
        priority: 0,
        allDay: false,
        scheduleKind: 'fixed',
      },
    });
    const lateTimed = occ('Collect parcel', {
      dueDate: null,
      dueAt: '2026-10-09T08:00:00.000Z',
      overdue: true,
      task: {
        title: 'Collect parcel',
        category: null,
        priority: 0,
        allDay: false,
        scheduleKind: 'fixed',
      },
    });
    const { text } = buildCopyList([timed, lateTimed], options('today'));
    expect(text).toContain('• Collect parcel — Anyone (was due Fri 9 Oct, 09:00)');
    expect(text).toContain('• Call the plumber — Anyone (14:30)');
  });

  it('orders items within a day by time', () => {
    const at = (title: string, dueAt: string) =>
      occ(title, {
        dueDate: null,
        dueAt,
        task: { title, category: null, priority: 0, allDay: false, scheduleKind: 'fixed' },
      });
    const { text } = buildCopyList(
      [at('Later', '2026-10-11T15:00:00.000Z'), at('Earlier', '2026-10-11T08:00:00.000Z')],
      options('today'),
    );
    expect(text.indexOf('Earlier')).toBeLessThan(text.indexOf('Later'));
  });
});

describe('wasCut', () => {
  it('is true when any response is as long as the limit', () => {
    expect(wasCut([3, 500])).toBe(true);
    expect(wasCut([3, 499])).toBe(false);
    expect(wasCut([])).toBe(false);
  });
});

describe('buildCopyList when cut', () => {
  it('ends with a line saying so', () => {
    const { text } = buildCopyList([today], { ...options('today'), cut: true });
    expect(
      text.endsWith('\n\nSome lists may have been cut at 500 tasks; see the app for the rest.'),
    ).toBe(true);
    expect(buildCopyList([today], options('today')).text).not.toContain('cut');
  });
});
