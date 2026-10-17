import { z } from 'zod';
import { taskFieldsIssues, taskPatchSchema } from './tasks.js';

/** A template never carries a person's assignment or an expired due date. */
export const templateDefaultsSchema = taskPatchSchema
  .pick({
    notes: true,
    category: true,
    scheduleKind: true,
    rrule: true,
    intervalAfterCompletionDays: true,
    leadTimeDays: true,
    milestones: true,
    reminderProfile: true,
    reminderSlot: true,
    reminderCustomTime: true,
    remindOffsetDays: true,
    workingDaysOnly: true,
  })
  .strict();

export const templateBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    keywords: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    defaults: templateDefaultsSchema,
  })
  .superRefine(({ defaults: d }, ctx) => {
    for (const issue of taskFieldsIssues({
      scheduleKind: d.scheduleKind ?? 'once',
      allDay: true,
      dueDate: '2026-01-01',
      rrule: d.rrule,
      intervalAfterCompletionDays: d.intervalAfterCompletionDays,
      reminderSlot: d.reminderSlot ?? 'evening',
      reminderCustomTime: d.reminderCustomTime,
    }))
      ctx.addIssue({ code: 'custom', path: ['defaults', ...issue.path], message: issue.message });
  });
export const templateSchema = templateBodySchema.safeExtend({
  id: z.string(),
  builtIn: z.boolean(),
});
export const templatesResponseSchema = z.object({ templates: z.array(templateSchema) });
export const templateResponseSchema = z.object({ template: templateSchema });
export type TemplateBody = z.infer<typeof templateBodySchema>;
export type Template = z.infer<typeof templateSchema>;

const milestones = (...steps: [string, number][]) =>
  steps.map(([title, offsetDaysBeforeDue]) => ({ title, offsetDaysBeforeDue }));

function yearly(
  id: string,
  title: string,
  category: string,
  keywords: string[],
  leadTimeDays: number,
  extra: Template['defaults'] = {},
): Template {
  return {
    id,
    title,
    keywords,
    builtIn: true,
    defaults: {
      category,
      notes: '',
      scheduleKind: 'fixed',
      rrule: 'FREQ=YEARLY',
      intervalAfterCompletionDays: null,
      leadTimeDays,
      milestones: [],
      reminderProfile: 'standard',
      reminderSlot: 'evening',
      reminderCustomTime: null,
      remindOffsetDays: 0,
      workingDaysOnly: false,
      ...extra,
    },
  };
}

/** UK starter library. Expiry/collection dates are chosen explicitly when applying. */
export const UK_TEMPLATES: readonly Template[] = [
  yearly(
    'car-insurance',
    'Car insurance renewal',
    'Car',
    ['car insurance', 'motor insurance'],
    30,
    {
      milestones: milestones(['Get quotes', 30], ['Decide', 14], ['Renew', 7]),
    },
  ),
  yearly('mot', 'MOT', 'Car', ['mot'], 30, {
    notes:
      'Choose the MOT expiry date. Testing up to a month minus a day early keeps the renewal date.',
    milestones: milestones(['Book MOT', 30]),
  }),
  yearly('car-tax', 'Car tax (VED)', 'Car', ['car tax', 'vehicle tax', 'ved'], 14),
  yearly('car-tax-monthly', 'Car tax (monthly)', 'Car', ['monthly car tax'], 14, {
    rrule: 'FREQ=MONTHLY',
  }),
  yearly('car-service', 'Car service', 'Car', ['car service', 'vehicle service'], 21, {
    notes: 'Check the mileage interval as well as the date.',
  }),
  yearly(
    'home-insurance',
    'Home insurance renewal',
    'Home',
    ['home insurance', 'house insurance', 'contents insurance'],
    30,
    {
      milestones: milestones(['Get quotes', 30], ['Decide', 14], ['Renew', 7]),
    },
  ),
  yearly('tv-licence', 'TV licence', 'Home', ['tv licence', 'tv license'], 14),
  yearly('passport', 'Passport renewal', 'Personal', ['passport'], 90, {
    scheduleKind: 'once',
    rrule: null,
    notes:
      'Choose the expiry date; check destination validity requirements. The prep window is 90 days.',
    milestones: milestones(['Check photo and forms', 90], ['Apply', 70]),
  }),
  yearly(
    'driving-licence',
    'Driving licence photocard',
    'Personal',
    ['driving licence', 'driving license', 'photocard'],
    60,
    {
      rrule: 'FREQ=YEARLY;INTERVAL=10',
      notes: 'Choose the photocard expiry date. Prep starts 60 days before.',
    },
  ),
  yearly(
    'self-assessment',
    'Self Assessment return and payment',
    'Finance',
    ['self assessment', 'tax return'],
    42,
    {
      rrule: 'FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=31',
      milestones: milestones(['Gather documents', 42], ['File return', 14]),
    },
  ),
  yearly('payment-on-account', 'Payment on account', 'Finance', ['payment on account'], 14, {
    rrule: 'FREQ=YEARLY;BYMONTH=7;BYMONTHDAY=31',
  }),
  yearly('boiler-service', 'Boiler service', 'Home', ['boiler service'], 21),
  ...['Energy', 'Broadband', 'Mobile'].map((name) =>
    yearly(
      `${name.toLowerCase()}-contract`,
      `${name} contract end`,
      'Home',
      [`${name.toLowerCase()} contract`, `${name.toLowerCase()} deal`],
      42,
      {
        scheduleKind: 'once',
        rrule: null,
        milestones: milestones(['Compare deals', 42], ['Switch', 21]),
      },
    ),
  ),
  yearly('birthday', 'Birthday', 'Personal', ['birthday'], 14, {
    milestones: milestones(['Buy gift or card', 14], ['Post card', 4]),
  }),
  yearly('anniversary', 'Anniversary', 'Personal', ['anniversary'], 14, {
    milestones: milestones(['Buy gift or card', 14], ['Post card', 4]),
  }),
  yearly(
    'alarm-test',
    'Smoke/CO alarm test',
    'Home',
    ['smoke alarm', 'co alarm', 'carbon monoxide'],
    0,
    { rrule: 'FREQ=MONTHLY', reminderProfile: 'gentle' },
  ),
  yearly('clocks-change', 'Clocks change', 'Home', ['clocks change', 'clock change'], 2, {
    rrule: 'FREQ=YEARLY;BYMONTH=3,10;BYDAY=-1SU',
    reminderProfile: 'gentle',
  }),
  yearly('bin-night', 'Bin night', 'Home', ['bin night', 'bins', 'bin collection'], 1, {
    rrule: 'FREQ=WEEKLY',
    remindOffsetDays: -1,
    reminderProfile: 'gentle',
    notes: 'Choose the collection date. Reminder is the evening before.',
  }),
  yearly(
    'bin-night-fortnightly',
    'Bin night (fortnightly)',
    'Home',
    ['recycling', 'fortnightly bins'],
    1,
    {
      rrule: 'FREQ=WEEKLY;INTERVAL=2',
      remindOffsetDays: -1,
      reminderProfile: 'gentle',
      notes:
        'Choose the first collection date. Create a second task one week later for the alternating bin.',
    },
  ),
];
