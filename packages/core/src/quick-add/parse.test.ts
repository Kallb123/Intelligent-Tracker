import { MAX_TITLE_LENGTH, taskBodySchema, type Template } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { RecurrenceError } from '../recurrence/errors.js';
import { parseQuickAdd, withDefaultAssignee } from './parse.js';
import { ALEX, context, SAM } from './test-util.js';

const parse = (text: string, overrides = {}) => parseQuickAdd(text, context(overrides));

describe('parseQuickAdd', () => {
  it('turns the worked example into a yearly car insurance task', () => {
    const result = parse('Car insurance renews 1/11 every year, sort it a month before');
    expect(result.template?.id).toBe('car-insurance');
    expect(result.task).toEqual({
      title: 'Car insurance renews',
      scheduleKind: 'fixed',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYMONTHDAY=1',
      allDay: true,
      dueDate: '2026-11-01',
      leadTimeDays: 30,
      milestones: [
        { title: 'Get quotes', offsetDaysBeforeDue: 30 },
        { title: 'Decide', offsetDaysBeforeDue: 14 },
        { title: 'Renew', offsetDaysBeforeDue: 7 },
      ],
      category: 'Car',
      reminderProfile: 'standard',
      reminderSlot: 'evening',
      remindOffsetDays: 0,
      workingDaysOnly: false,
      assigneeIds: [],
    });
  });

  it('lists what it understood in input order, with offsets into the text', () => {
    const text = 'Car insurance renews 1/11 every year, sort it a month before';
    const { matched } = parse(text);
    expect(matched.map((m) => [m.kind, m.text])).toEqual([
      ['template', 'Car insurance'],
      ['date', '1/11'],
      ['recurrence', 'every year'],
      ['lead', 'sort it a month before'],
    ]);
    for (const m of matched) expect(text.slice(m.start, m.end)).toBe(m.text);
  });

  it('lets explicit phrases win over the template', () => {
    const result = parse('Car insurance 1/11 3 weeks before, every 2 years');
    expect(result.task).toMatchObject({
      leadTimeDays: 21,
      rrule: 'FREQ=YEARLY;INTERVAL=2;BYMONTH=11;BYMONTHDAY=1',
      // What the user did not say still comes from the template.
      milestones: [{ title: 'Get quotes' }, { title: 'Decide' }, { title: 'Renew' }],
    });
    const offset = parse('bins every Tuesday, remind me the morning before');
    expect(offset.task).toMatchObject({ remindOffsetDays: -1, reminderSlot: 'morning' });
  });

  it('replaces a template custom time when the text sets the slot', () => {
    const template: Template = {
      id: 'meds',
      title: 'Meds',
      keywords: ['meds'],
      builtIn: false,
      defaults: { reminderSlot: 'custom_time', reminderCustomTime: '07:30' },
    };
    const templates = [template];
    expect(parse('meds', { templates }).task).toMatchObject({
      reminderSlot: 'custom_time',
      reminderCustomTime: '07:30',
    });
    const overridden = parse('meds the night before', { templates }).task;
    expect(overridden).toMatchObject({ reminderSlot: 'evening', remindOffsetDays: -1 });
    expect(overridden).not.toHaveProperty('reminderCustomTime');
  });

  it('only takes a template’s repeat when there is a date to hang it on', () => {
    expect(parse('Renew MOT').task).toMatchObject({ scheduleKind: 'once', allDay: true });
    expect(parse('Renew MOT').task).not.toHaveProperty('dueDate');
    expect(parse('Renew MOT 14/03').task).toMatchObject({
      scheduleKind: 'fixed',
      dueDate: '2027-03-14',
    });
    // A one-off template stays one-off.
    expect(parse('Passport 5 March 2027').task).toMatchObject({ scheduleKind: 'once' });
  });

  it('leaves what it does not understand in the title', () => {
    expect(parse('Ring the plumber about the 2 leaks tomorrow').task.title).toBe(
      'Ring the plumber about the 2 leaks',
    );
    expect(parse('Feed cat every morning').task.title).toBe('Feed cat every morning');
    expect(parse('Call dentist at 5').task.title).toBe('Call dentist at 5');
  });

  it('never returns an empty title', () => {
    // Nothing but schedule: the text itself is the title.
    expect(parse('every Tuesday').task.title).toBe('every Tuesday');
    expect(parse('1/11').task.title).toBe('1/11');
    // A template matched on a word that only cleaning would strip: the template's title.
    const template: Template = {
      id: 'x',
      title: 'Template title',
      keywords: ['in'],
      builtIn: false,
      defaults: {},
    };
    expect(parse('daily in', { templates: [template] }).task.title).toBe('Template title');
  });

  it('limits the title to what the api accepts', () => {
    expect(parse(`${'a'.repeat(250)} tomorrow`).task.title).toHaveLength(MAX_TITLE_LENGTH);
  });

  it('does not split an emoji when it cuts a long title', () => {
    // The emoji's two halves sit at indexes 199 and 200, right on the limit.
    const { title } = parse(`${'a'.repeat(199)}😀${'b'.repeat(50)} tomorrow`).task;
    expect(title).toBe('a'.repeat(199));
    expect(() => encodeURIComponent(title)).not.toThrow();
    const { task } = parse(`${'a'.repeat(198)}😀${'b'.repeat(50)} tomorrow`);
    expect(task.title).toBe(`${'a'.repeat(198)}😀`);
    expect(taskBodySchema.safeParse(task).success).toBe(true);
    expect(() => JSON.stringify(task)).not.toThrow();
  });

  it('names the assignee but leaves unknown names in the title', () => {
    expect(parse('@Sam wash up').task).toMatchObject({ title: 'wash up', assigneeIds: [SAM.id] });
    expect(parse('wash up for alex').task.assigneeIds).toEqual([ALEX.id]);
    expect(parse('Call the vet for mum').task).toMatchObject({
      title: 'Call the vet for mum',
      assigneeIds: [],
    });
  });

  it('reads "tomorrow" in the household zone', () => {
    const late = new Date('2026-10-17T23:30:00Z');
    expect(parse('bins tomorrow', { now: late }).task.dueDate).toBe('2026-10-19');
    const newYork = parse('bins tomorrow', { timezone: 'America/New_York' });
    expect(newYork.task.dueDate).toBe('2026-10-18');
  });

  it('produces a task the api accepts', () => {
    for (const text of ['', 'Buy milk', 'Dentist 24/10 at 09:00 for Sam', 'every day']) {
      const { task } = parse(text);
      // A blank input has no title; everything else must validate.
      if (text) expect(taskBodySchema.safeParse(task).success, text).toBe(true);
    }
    expect(parse('').task.title).toBe('');
  });

  it('throws for an unknown time zone', () => {
    expect(() => parse('bins', { timezone: 'Mars/Olympus' })).toThrow(RecurrenceError);
  });
});

describe('withDefaultAssignee', () => {
  const task = parse('bins tomorrow').task;

  it('gives a task nobody was named for to the author', () => {
    expect(withDefaultAssignee(task, ALEX.id).assigneeIds).toEqual([ALEX.id]);
  });

  it('keeps an assignee named in the text', () => {
    const named = parse('bins tomorrow @Sam').task;
    expect(withDefaultAssignee(named, ALEX.id)).toBe(named);
  });

  it('leaves the task alone when there is no author', () => {
    expect(withDefaultAssignee(task, undefined)).toBe(task);
    expect(task.assigneeIds).toEqual([]);
  });
});
