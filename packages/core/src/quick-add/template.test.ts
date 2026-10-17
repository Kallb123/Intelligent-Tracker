import { UK_TEMPLATES, type Template } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { matchTemplate, templateFields, templateKeywordSpan, templatePattern } from './template.js';

const byId = (id: string): Template => UK_TEMPLATES.find((t) => t.id === id) as Template;

describe('matchTemplate', () => {
  it('picks the best keyword match, or nothing', () => {
    expect(matchTemplate('Renew car insurance', UK_TEMPLATES)?.id).toBe('car-insurance');
    expect(matchTemplate('book the MOT', UK_TEMPLATES)?.id).toBe('mot');
    expect(matchTemplate('Buy milk', UK_TEMPLATES)).toBeNull();
    expect(matchTemplate('', UK_TEMPLATES)).toBeNull();
  });

  it('includes the household’s own templates', () => {
    const mine: Template = {
      id: 'mine',
      title: 'Wash Dave',
      keywords: ['dog bath'],
      builtIn: false,
      defaults: { scheduleKind: 'once', leadTimeDays: 2 },
    };
    expect(matchTemplate('dog bath', [...UK_TEMPLATES, mine])).toBe(mine);
  });
});

describe('templateKeywordSpan', () => {
  it('finds the keyword as the user wrote it', () => {
    const text = 'Renew Car   Insurance soon';
    const span = templateKeywordSpan(text, byId('car-insurance'));
    expect(text.slice(span?.start, span?.end)).toBe('Car   Insurance');
  });

  it('prefers the longest keyword and whole words', () => {
    const text = 'monthly car tax';
    const span = templateKeywordSpan(text, byId('car-tax-monthly'));
    expect(text.slice(span?.start, span?.end)).toBe('monthly car tax');
    expect(templateKeywordSpan('commotion', byId('mot'))).toBeNull();
  });

  it('skips keywords with no letters or digits', () => {
    const template: Template = { ...byId('mot'), keywords: ['!!!', 'mot'] };
    expect(templateKeywordSpan('book mot', template)).toEqual({ start: 5, end: 8 });
    expect(templateKeywordSpan('book', { ...template, keywords: ['!!!'] })).toBeNull();
  });

  it('escapes punctuation in keywords', () => {
    const template: Template = { ...byId('mot'), keywords: ['c++ course'] };
    expect(templateKeywordSpan('a c++ course', template)).toEqual({ start: 2, end: 12 });
  });
});

describe('templatePattern', () => {
  it('anchors a template rule on the due date', () => {
    expect(templatePattern(byId('mot'), '2027-03-14')).toEqual({
      kind: 'rrule',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=14',
    });
  });

  it('has nothing for a one-off template, and reads after-completion ones', () => {
    expect(templatePattern(byId('passport'), '2027-03-14')).toBeUndefined();
    const chore: Template = {
      ...byId('mot'),
      defaults: { scheduleKind: 'after_completion', intervalAfterCompletionDays: 42 },
    };
    expect(templatePattern(chore, '2027-03-14')).toEqual({ kind: 'after_completion', days: 42 });
  });
});

describe('templateFields', () => {
  it('copies lead time, milestones, profile, category and notes', () => {
    const fields = templateFields(byId('car-insurance'));
    expect(fields).toMatchObject({
      leadTimeDays: 30,
      category: 'Car',
      reminderProfile: 'standard',
      reminderSlot: 'evening',
      remindOffsetDays: 0,
      milestones: [
        { title: 'Get quotes', offsetDaysBeforeDue: 30 },
        { title: 'Decide', offsetDaysBeforeDue: 14 },
        { title: 'Renew', offsetDaysBeforeDue: 7 },
      ],
    });
    expect(fields).not.toHaveProperty('notes');
    expect(fields).not.toHaveProperty('workingDaysOnly');
  });

  it('copies milestones rather than sharing them', () => {
    const template = byId('car-insurance');
    const fields = templateFields(template);
    expect(fields.milestones?.[0]).not.toBe(template.defaults.milestones?.[0]);
  });

  it('carries the evening-before offset, notes, working days and a custom time', () => {
    expect(templateFields(byId('bin-night'))).toMatchObject({
      remindOffsetDays: -1,
      leadTimeDays: 1,
      reminderProfile: 'gentle',
      notes: expect.stringContaining('evening before'),
    });
    const custom: Template = {
      ...byId('mot'),
      defaults: {
        workingDaysOnly: true,
        reminderSlot: 'custom_time',
        reminderCustomTime: '07:30',
      },
    };
    expect(templateFields(custom)).toEqual({
      workingDaysOnly: true,
      reminderSlot: 'custom_time',
      reminderCustomTime: '07:30',
    });
    expect(templateFields({ ...custom, defaults: {} })).toEqual({});
  });

  it('keeps a lead time of zero', () => {
    expect(templateFields(byId('alarm-test'))).toMatchObject({ leadTimeDays: 0 });
  });
});
