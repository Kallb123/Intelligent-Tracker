import { parseQuickAdd } from '@tracker/core';
import { UK_TEMPLATES, taskBodySchema } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { highlightMatches, quickAddBody, quickAddForm } from './quick-add.js';

const TZ = 'Europe/London';
const NOW = new Date('2026-10-11T10:00:00Z');
const ME = '11111111-1111-4111-8111-111111111111';
const SAM = '44444444-4444-4444-8444-444444444444';
const members = [
  { id: ME, name: 'Alex' },
  { id: SAM, name: 'Sam' },
];
const parse = (text: string) =>
  parseQuickAdd(text, { now: NOW, timezone: TZ, members, templates: UK_TEMPLATES });

const EXAMPLE = 'Car insurance renews 1/11 every year, sort it a month before';

describe('quickAddBody', () => {
  it('is a body the api accepts, with only what was understood or set by a template', () => {
    const body = quickAddBody(parse(EXAMPLE), ME);
    expect(taskBodySchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      title: 'Car insurance renews',
      scheduleKind: 'fixed',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYMONTHDAY=1',
      dueDate: '2026-11-01',
      leadTimeDays: 30,
      reminderProfile: 'standard',
      assigneeIds: [ME],
    });
    expect(body.milestones?.map((m) => m.title)).toEqual(['Get quotes', 'Decide', 'Renew']);
  });

  it('assigns the person adding it when the text named nobody, and keeps a named assignee', () => {
    expect(quickAddBody(parse(EXAMPLE), ME).assigneeIds).toEqual([ME]);
    expect(quickAddBody(parse(EXAMPLE), undefined).assigneeIds).toEqual([]);
    expect(quickAddBody(parse('Put the bins out every Monday @Sam'), ME).assigneeIds).toEqual([
      SAM,
    ]);
  });

  it('leaves the reminder profile to the api when no template set it', () => {
    expect(quickAddBody(parse('Water the plants every week'), ME)).not.toHaveProperty(
      'reminderProfile',
    );
  });
});

describe('quickAddForm', () => {
  it('fills the editor form from the parse, for the person adding it', () => {
    expect(quickAddForm(parse(EXAMPLE), ME, TZ)).toMatchObject({
      title: 'Car insurance renews',
      category: 'Car',
      allDay: true,
      dueDate: '2026-11-01',
      recurrence: { kind: 'yearly' },
      leadTimeDays: 30,
      milestones: [
        { title: 'Get quotes', days: 30 },
        { title: 'Decide', days: 14 },
        { title: 'Renew', days: 7 },
      ],
      reminderProfile: 'standard',
      assignmentMode: 'fixed',
      fixedAssignee: ME,
    });
  });

  it('leaves the profile on the household default when the parse set none', () => {
    const form = quickAddForm(parse('Water the plants every week'), ME, TZ);
    expect(form.reminderProfile).toBe('');
    expect(form.recurrence).toMatchObject({ kind: 'weekly' });
  });

  it('uses the named assignee', () => {
    expect(quickAddForm(parse('Put the bins out every Monday @Sam'), ME, TZ).fixedAssignee).toBe(
      SAM,
    );
  });
});

describe('highlightMatches', () => {
  it('cuts the text into plain and understood pieces', () => {
    const p = parse(EXAMPLE);
    const segments = highlightMatches(EXAMPLE, p.matched);
    expect(segments.map((s) => s.text).join('')).toBe(EXAMPLE);
    expect(segments.filter((s) => s.kind).map((s) => [s.kind, s.text])).toEqual([
      ['template', 'Car insurance'],
      ['date', '1/11'],
      ['recurrence', 'every year'],
      ['lead', 'sort it a month before'],
    ]);
  });

  it('is one plain piece when nothing was understood, and empty for no text', () => {
    expect(highlightMatches('Do a thing', [])).toEqual([{ text: 'Do a thing', kind: null }]);
    expect(highlightMatches('', [])).toEqual([]);
  });

  it('skips a piece that overlaps an earlier one', () => {
    const text = 'abcdef';
    expect(
      highlightMatches(text, [
        { kind: 'date', text: 'abcd', start: 0, end: 4 },
        { kind: 'lead', text: 'cde', start: 2, end: 5 },
      ]),
    ).toEqual([
      { text: 'abcd', kind: 'date' },
      { text: 'ef', kind: null },
    ]);
  });
});
