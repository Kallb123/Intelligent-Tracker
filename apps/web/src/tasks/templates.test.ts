import { UK_TEMPLATES } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { applyTemplate, templateFromForm } from './templates.js';
import { newTaskForm, previewSchedule, taskBody } from './task-form.js';

describe('template editor', () => {
  const template = (id: string) => UK_TEMPLATES.find((t) => t.id === id)!;
  it('keeps a title, expiry and people, applies milestones without mutating the catalogue', () => {
    const form = newTaskForm('2026-11-01', 'alex');
    form.title = 'Our car insurance';
    const result = applyTemplate(form, template('car-insurance'), 'Europe/London');
    expect(result).toMatchObject({
      title: form.title,
      dueDate: form.dueDate,
      fixedAssignee: 'alex',
      leadTimeDays: 30,
    });
    expect(taskBody(result, 'Europe/London').milestones).toHaveLength(3);
    result.milestones[0]!.title = 'Changed';
    expect(template('car-insurance').defaults.milestones?.[0]?.title).toBe('Get quotes');
  });
  it('chooses the next fixed tax deadline and keeps a 10-year photocard interval', () => {
    const form = newTaskForm('2026-10-01', 'alex');
    expect(applyTemplate(form, template('self-assessment'), 'Europe/London').dueDate).toBe(
      '2027-01-31',
    );
    const licence = applyTemplate(form, template('driving-licence'), 'Europe/London');
    expect(taskBody(licence, 'Europe/London').rrule).toContain('INTERVAL=10');
  });
  it('stores bin reminders the evening before and omits dates/people from saved templates', () => {
    const result = applyTemplate(
      newTaskForm('2026-11-03', 'alex'),
      template('bin-night'),
      'Europe/London',
    );
    const saved = templateFromForm(result, 'Europe/London', ['bins']);
    expect(saved.defaults).toMatchObject({ remindOffsetDays: -1, reminderSlot: 'evening' });
    expect(saved.defaults).not.toHaveProperty('dueDate');
    expect(saved.defaults).not.toHaveProperty('assigneeIds');
  });
  it('previews unique shifted working dates from the same cache as materialisation', () => {
    const form = newTaskForm('2026-12-25', 'alex');
    form.recurrence.kind = 'daily';
    form.workingDaysOnly = true;
    const preview = previewSchedule(
      form,
      'Europe/London',
      new Date('2026-12-25T00:00Z'),
      5,
      new Set(['2026-12-25', '2026-12-28']),
    );
    expect(preview).toMatchObject({
      dues: [
        { date: '2026-12-29' },
        { date: '2026-12-30' },
        { date: '2026-12-31' },
        { date: '2027-01-01' },
        { date: '2027-01-04' },
      ],
    });
  });
});
