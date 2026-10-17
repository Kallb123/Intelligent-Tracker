import { parseRecurrence, previewDates, scheduleFromTask } from '@tracker/core';
import {
  templateDefaultsSchema,
  templateScheduleFields,
  type Template,
  type TemplateBody,
} from '@tracker/shared';
import { taskBody, type TaskForm } from './task-form.js';

/** Apply only after confirmation; keep the task's title, people and chosen expiry/collection date. */
export function applyTemplate(form: TaskForm, template: Template, timezone: string): TaskForm {
  const d = template.defaults;
  const schedule = templateScheduleFields(d, form.dueDate);
  let dueDate = form.dueDate;
  // Calendar-anchored rules (tax deadlines, clocks) choose their next valid date.
  if (schedule.scheduleKind === 'fixed' && dueDate) {
    const [next] = previewDates(scheduleFromTask(schedule), new Date(`${dueDate}T00:00:00Z`), 1, {
      timezone,
    });
    if (next?.allDay) dueDate = next.date;
  }
  return {
    ...form,
    title: form.title.trim() ? form.title : template.title,
    dueDate,
    notes: d.notes ?? '',
    category: d.category ?? '',
    recurrence: parseRecurrence(schedule),
    leadTimeDays: d.leadTimeDays ?? null,
    milestones: (d.milestones ?? []).map((m) => ({ title: m.title, days: m.offsetDaysBeforeDue })),
    reminderProfile: d.reminderProfile ?? '',
    reminderSlot: d.reminderSlot ?? 'evening',
    reminderCustomTime: d.reminderCustomTime ?? '19:00',
    remindOffsetDays: d.remindOffsetDays ?? 0,
    workingDaysOnly: d.workingDaysOnly ?? false,
  };
}

export function templateFromForm(
  form: TaskForm,
  timezone: string,
  keywords: string[],
): TemplateBody {
  const body = taskBody(form, timezone);
  return {
    title: form.title.trim(),
    keywords,
    defaults: templateDefaultsSchema.parse(
      Object.fromEntries(
        Object.entries(body).filter(([key]) => key in templateDefaultsSchema.shape),
      ),
    ),
  };
}
