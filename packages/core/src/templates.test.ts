import { UK_TEMPLATES, taskBodySchema, templateBodySchema } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { suggestTemplates } from './templates.js';
import { scheduleFromTask } from './recurrence/schedule.js';

describe('UK template pack', () => {
  it.each([
    ['Renew CAR insurance', 'car-insurance'],
    ['book MOT', 'mot'],
    ['TV license renewal', 'tv-licence'],
    ['File self-assessment', 'self-assessment'],
    ['Check carbon monoxide alarm', 'alarm-test'],
    ['Switch broadband deal', 'broadband-contract'],
  ])('suggests %s', (text, id) => {
    expect(suggestTemplates(text, UK_TEMPLATES)[0]?.id).toBe(id);
  });
  it('matches whole words and leaves unrelated titles alone', () => {
    for (const title of ['', 'remote control', 'commotion', 'taxidermy', 'hoover']) {
      expect(suggestTemplates(title, UK_TEMPLATES)).toEqual([]);
    }
  });
  it('ranks specific phrases first and supports user keywords', () => {
    const template = {
      ...UK_TEMPLATES[0]!,
      id: 'mine',
      builtIn: false,
      keywords: ['renew car insurance'],
    };
    expect(suggestTemplates('renew car insurance', [...UK_TEMPLATES, template])[0]?.id).toBe(
      'mine',
    );
  });
  it('ships unique, valid, independently editable templates', () => {
    expect(new Set(UK_TEMPLATES.map((t) => t.id)).size).toBe(UK_TEMPLATES.length);
    for (const template of UK_TEMPLATES) {
      expect(templateBodySchema.safeParse(template).success, template.id).toBe(true);
      const body = taskBodySchema.parse({
        title: template.title,
        dueDate: '2026-01-01',
        scheduleKind: 'once',
        ...template.defaults,
      });
      expect(() =>
        scheduleFromTask({
          ...body,
          dueDate: body.dueDate ?? null,
          dueAt: null,
          rrule: body.rrule ?? null,
          intervalAfterCompletionDays: body.intervalAfterCompletionDays ?? null,
        }),
      ).not.toThrow();
    }
  });
});
