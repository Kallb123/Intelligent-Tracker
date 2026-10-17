import { taskBodySchema } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from './parse.js';
import { describeQuickAdd } from './summary.js';
import { ALEX, context, MEMBERS, NOW, SAM, TZ } from './test-util.js';

/**
 * The PR 17 corpus: UK-phrased examples and what each must parse to. "Now" is Saturday 17 October
 * 2026, 12:00 in London (BST until Sunday 25 October); the members are Alex Smith and Sam Jones;
 * templates are the built-in UK pack. A field left out of an expectation must be absent: no lead
 * time, no remind offset, nobody assigned, no template, a one-off.
 *
 * Worth knowing when reading a row:
 * - dates are day first, and one without a year is the next such date ("14/03" is 2027);
 * - a timed task's `due` is an instant: 09:00 on 24 October is 08:00Z (BST), on 26 October 09:00Z
 *   (GMT), and 01:30 on 28 March 2027 does not exist, so it becomes 02:30 BST (01:30Z);
 * - a recurring task with no date starts on its first match from now, and "every month" with
 *   no date repeats on today's date;
 * - what the parser does not understand ("Feed cat every morning", "Call dentist at 5") stays in
 *   the title (so does the unclear hour of "tomorrow at 5", while "tomorrow" is read), and "for mum" is not an assignee because mum is not a member.
 */
interface Expected {
  title: string;
  kind?: 'fixed' | 'after_completion';
  /** An all-day date, or the ISO instant of a timed task. */
  due?: string;
  rrule?: string;
  /** Days between finishing and the next due. */
  days?: number;
  lead?: number;
  offset?: number;
  slot?: 'morning' | 'custom_time';
  who?: 'alex' | 'sam';
  template?: string;
}

const MEMBER_IDS = { alex: ALEX.id, sam: SAM.id };

const CORPUS: [text: string, expected: Expected][] = [
  [
    'Car insurance renews 1/11 every year, sort it a month before',
    {
      title: 'Car insurance renews',
      kind: 'fixed',
      due: '2026-11-01',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYMONTHDAY=1',
      lead: 30,
      template: 'car-insurance',
    },
  ],
  [
    'MOT due 14/03, remind me a month before',
    {
      title: 'MOT',
      kind: 'fixed',
      due: '2027-03-14',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=14',
      lead: 30,
      template: 'mot',
    },
  ],
  [
    'put the bins out every Tuesday, remind me the night before',
    {
      title: 'put the bins out',
      kind: 'fixed',
      due: '2026-10-20',
      rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
      lead: 1,
      offset: -1,
      template: 'bin-night',
    },
  ],
  [
    'every other Tuesday',
    {
      title: 'every other Tuesday',
      kind: 'fixed',
      due: '2026-10-27',
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
    },
  ],
  [
    'Recycling every other Tuesday',
    {
      title: 'Recycling',
      kind: 'fixed',
      due: '2026-10-27',
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
      lead: 1,
      offset: -1,
      template: 'bin-night-fortnightly',
    },
  ],
  [
    'Pay rent last Friday of the month',
    {
      title: 'Pay rent',
      kind: 'fixed',
      due: '2026-10-30',
      rrule: 'FREQ=MONTHLY;INTERVAL=1;BYDAY=-1FR',
    },
  ],
  [
    'Team lunch on weekdays',
    {
      title: 'Team lunch',
      kind: 'fixed',
      due: '2026-10-19',
      rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR',
    },
  ],
  [
    'Clean the filter every 6 weeks after done',
    { title: 'Clean the filter', kind: 'after_completion', due: '2026-10-17', days: 42 },
  ],
  [
    "Descale kettle 6 weeks after it's done",
    { title: 'Descale kettle', kind: 'after_completion', due: '2026-10-17', days: 42 },
  ],
  [
    '@Sam take the bins out tomorrow',
    {
      title: 'take the bins out',
      kind: 'fixed',
      due: '2026-10-18',
      rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=SU',
      lead: 1,
      offset: -1,
      who: 'sam',
      template: 'bin-night',
    },
  ],
  [
    'take bins out for Sam on Friday',
    {
      title: 'take bins out',
      kind: 'fixed',
      due: '2026-10-23',
      rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=FR',
      lead: 1,
      offset: -1,
      who: 'sam',
      template: 'bin-night',
    },
  ],
  ['Call the vet for mum tomorrow', { title: 'Call the vet for mum', due: '2026-10-18' }],
  ['Buy flowers @alex next Tuesday', { title: 'Buy flowers', due: '2026-10-20', who: 'alex' }],
  ['Pay council tax 1/11', { title: 'Pay council tax', due: '2026-11-01' }],
  ['Pay council tax 01/11/2026', { title: 'Pay council tax', due: '2026-11-01' }],
  ['Dentist 5/11/27 at 2:30pm', { title: 'Dentist', due: '2027-11-05T14:30:00.000Z' }],
  ['Dentist 24/10 at 09:00', { title: 'Dentist', due: '2026-10-24T08:00:00.000Z' }],
  ['Dentist 26/10 at 09:00', { title: 'Dentist', due: '2026-10-26T09:00:00.000Z' }],
  ['Doctor 28/03/27 at 01:30', { title: 'Doctor', due: '2027-03-28T01:30:00.000Z' }],
  ['Doctor 31/10/26 at 8am', { title: 'Doctor', due: '2026-10-31T08:00:00.000Z' }],
  ['Cake 29/02', { title: 'Cake', due: '2028-02-29' }],
  ['Cake 29 Feb', { title: 'Cake', due: '2028-02-29' }],
  ['Cake 29/02/2028', { title: 'Cake', due: '2028-02-29' }],
  ['Do thing 31/02', { title: 'Do thing 31/02' }],
  [
    'Renew passport 5 March 2027',
    { title: 'Renew passport', due: '2027-03-05', lead: 90, template: 'passport' },
  ],
  [
    'Self assessment 31/01',
    {
      title: 'Self assessment',
      kind: 'fixed',
      due: '2027-01-31',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=1;BYMONTHDAY=31',
      lead: 42,
      template: 'self-assessment',
    },
  ],
  [
    'Payment on account 31/07, 2 weeks before',
    {
      title: 'Payment on account',
      kind: 'fixed',
      due: '2027-07-31',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=7;BYMONTHDAY=31',
      lead: 14,
      template: 'payment-on-account',
    },
  ],
  [
    'TV licence 12/12 every year',
    {
      title: 'TV licence',
      kind: 'fixed',
      due: '2026-12-12',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=12;BYMONTHDAY=12',
      lead: 14,
      template: 'tv-licence',
    },
  ],
  [
    'Smoke alarm test on the first Monday of every month',
    {
      title: 'Smoke alarm test',
      kind: 'fixed',
      due: '2026-11-02',
      rrule: 'FREQ=MONTHLY;INTERVAL=1;BYDAY=1MO',
      lead: 0,
      template: 'alarm-test',
    },
  ],
  [
    'Smoke alarm test monthly',
    {
      title: 'Smoke alarm test',
      kind: 'fixed',
      due: '2026-10-17',
      rrule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=17',
      lead: 0,
      template: 'alarm-test',
    },
  ],
  ['Clocks change', { title: 'Clocks change', lead: 2, template: 'clocks-change' }],
  [
    'Boiler service 3 weeks before 20/11',
    {
      title: 'Boiler service',
      kind: 'fixed',
      due: '2026-11-20',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYMONTHDAY=20',
      lead: 21,
      template: 'boiler-service',
    },
  ],
  [
    'Water plants every 3 days',
    { title: 'Water plants', kind: 'fixed', due: '2026-10-17', rrule: 'FREQ=DAILY;INTERVAL=3' },
  ],
  [
    'Take meds every day at 07:30',
    {
      title: 'Take meds',
      kind: 'fixed',
      due: '2026-10-18T06:30:00.000Z',
      rrule: 'FREQ=DAILY;INTERVAL=1',
    },
  ],
  [
    'Take meds daily at 8am',
    {
      title: 'Take meds',
      kind: 'fixed',
      due: '2026-10-18T07:00:00.000Z',
      rrule: 'FREQ=DAILY;INTERVAL=1',
    },
  ],
  [
    'Hoover weekly',
    { title: 'Hoover', kind: 'fixed', due: '2026-10-17', rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=SA' },
  ],
  [
    'Gym every Mon, Wed & Fri 6pm',
    {
      title: 'Gym',
      kind: 'fixed',
      due: '2026-10-19T17:00:00.000Z',
      rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR',
    },
  ],
  [
    'Swimming every Monday and Thursday',
    {
      title: 'Swimming',
      kind: 'fixed',
      due: '2026-10-19',
      rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TH',
    },
  ],
  [
    'Bin day every fortnight on Wednesday',
    {
      title: 'Bin day',
      kind: 'fixed',
      due: '2026-10-21',
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE',
    },
  ],
  [
    'Rent every month',
    {
      title: 'Rent',
      kind: 'fixed',
      due: '2026-10-17',
      rrule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=17',
    },
  ],
  [
    'Pay window cleaner every month on the 28th',
    {
      title: 'Pay window cleaner',
      kind: 'fixed',
      due: '2026-10-28',
      rrule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=28',
    },
  ],
  [
    'Wash the car every 2 months',
    {
      title: 'Wash the car',
      kind: 'fixed',
      due: '2026-10-17',
      rrule: 'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=17',
    },
  ],
  [
    'Birthday cake every year on 3 June',
    {
      title: 'Birthday cake',
      kind: 'fixed',
      due: '2027-06-03',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=6;BYMONTHDAY=3',
      lead: 14,
      template: 'birthday',
    },
  ],
  [
    "Mum's birthday 03/06 every year, 2 weeks before",
    {
      title: "Mum's birthday",
      kind: 'fixed',
      due: '2027-06-03',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=6;BYMONTHDAY=3',
      lead: 14,
      template: 'birthday',
    },
  ],
  [
    'Anniversary 14/02 yearly, a week before',
    {
      title: 'Anniversary',
      kind: 'fixed',
      due: '2027-02-14',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=2;BYMONTHDAY=14',
      lead: 7,
      template: 'anniversary',
    },
  ],
  [
    'Vacuum every other week',
    { title: 'Vacuum', kind: 'fixed', due: '2026-10-17', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA' },
  ],
  [
    'Pay insurance annually 15/03',
    {
      title: 'Pay insurance',
      kind: 'fixed',
      due: '2027-03-15',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=15',
    },
  ],
  ['Book flights 3 days ahead of 20/12', { title: 'Book flights', due: '2026-12-20', lead: 3 }],
  ['Order poppies 1 week early 11/11', { title: 'Order poppies', due: '2026-11-11', lead: 7 }],
  ['Renew licence 6 weeks before 12/03', { title: 'Renew licence', due: '2027-03-12', lead: 42 }],
  [
    'Taxi for Alex at 6am tomorrow',
    { title: 'Taxi', due: '2026-10-18T05:00:00.000Z', who: 'alex' },
  ],
  ['Call Alex Smith in 2 weeks', { title: 'Call Alex Smith', due: '2026-10-31' }],
  ['for Alex pick up parcel today', { title: 'pick up parcel', due: '2026-10-17', who: 'alex' }],
  ['Order shopping tonight', { title: 'Order shopping', due: '2026-10-17' }],
  ['Sun cream', { title: 'Sun cream' }],
  ['Sat on the fence', { title: 'Sat on the fence' }],
  ['Call dentist at 5', { title: 'Call dentist at 5' }],
  ['Pay March invoice', { title: 'Pay March invoice' }],
  ['Dec 25 party', { title: 'Dec 25 party' }],
  ['Renew 2 year warranty', { title: 'Renew 2 year warranty' }],
  ['Meet at 5pm', { title: 'Meet', due: '2026-10-17T16:00:00.000Z' }],
  ['Dentist next Monday 10:15', { title: 'Dentist', due: '2026-10-19T09:15:00.000Z' }],
  ['Mow lawn Saturday', { title: 'Mow lawn', due: '2026-10-24' }],
  ['Fix the fence this Sunday', { title: 'Fix the fence', due: '2026-10-18' }],
  ['Lunch with gran noon on 21/11', { title: 'Lunch with gran', due: '2026-11-21T12:00:00.000Z' }],
  ['Pick up prescription before Friday', { title: 'Pick up prescription', due: '2026-10-23' }],
  [
    'Research broadband deal switch 1/12',
    {
      title: 'Research broadband deal switch',
      due: '2026-12-01',
      lead: 42,
      template: 'broadband-contract',
    },
  ],
  [
    'Energy contract ends 30/11, compare deals 6 weeks before',
    {
      title: 'Energy contract ends, compare deals',
      due: '2026-11-30',
      lead: 42,
      template: 'energy-contract',
    },
  ],
  [
    'Mobile contract 18/02/2027',
    { title: 'Mobile contract', due: '2027-02-18', lead: 42, template: 'mobile-contract' },
  ],
  [
    'Passport expires 14/08/2030 sort it 3 months ahead',
    { title: 'Passport expires', due: '2030-08-14', lead: 90, template: 'passport' },
  ],
  [
    'Driving licence photocard 9/9/2029',
    {
      title: 'Driving licence photocard',
      kind: 'fixed',
      due: '2029-09-09',
      rrule: 'FREQ=YEARLY;INTERVAL=10;BYMONTH=9;BYMONTHDAY=9',
      lead: 60,
      template: 'driving-licence',
    },
  ],
  [
    'Pay credit card on the last day of every month',
    {
      title: 'Pay credit card',
      kind: 'fixed',
      due: '2026-10-31',
      rrule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1',
    },
  ],
  [
    'Pay bills on the last day of each month',
    {
      title: 'Pay bills',
      kind: 'fixed',
      due: '2026-10-31',
      rrule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1',
    },
  ],
  [
    'Take bins out Monday night, remind me the evening before',
    {
      title: 'Take bins out',
      kind: 'fixed',
      due: '2026-10-19',
      rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
      lead: 1,
      offset: -1,
      template: 'bin-night',
    },
  ],
  ['Feed cat every morning', { title: 'Feed cat every morning' }],
  ['Buy 3/4 inch bolts', { title: 'Buy 3/4 inch bolts' }],
  ['Buy 1/2 kg flour', { title: 'Buy 1/2 kg flour' }],
  ['Check the 1/2 price offers', { title: 'Check the 1/2 price offers' }],
  ['Cancel the 24/7 helpline', { title: 'Cancel the 24/7 helpline' }],
  ['Fix boiler tomorrow at 5', { title: 'Fix boiler at 5', due: '2026-10-18' }],
  ['Call plumber at 5 tomorrow', { title: 'Call plumber at 5', due: '2026-10-18' }],
  ['Fix boiler tomorrow at 5pm', { title: 'Fix boiler', due: '2026-10-18T16:00:00.000Z' }],
  [
    'Pay rent on the 1st every month',
    {
      title: 'Pay rent',
      kind: 'fixed',
      due: '2026-11-01',
      rrule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1',
    },
  ],
  [
    'Pay rent every month on the 1st',
    {
      title: 'Pay rent',
      kind: 'fixed',
      due: '2026-11-01',
      rrule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1',
    },
  ],
  [
    'Meter reading the 20th of each month',
    {
      title: 'Meter reading',
      kind: 'fixed',
      due: '2026-10-20',
      rrule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=20',
    },
  ],
  [
    'Insurance renews 1/11 every year',
    {
      title: 'Insurance renews',
      kind: 'fixed',
      due: '2026-11-01',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYMONTHDAY=1',
    },
  ],
  ['Flu jab 2 Nov 9am', { title: 'Flu jab', due: '2026-11-02T09:00:00.000Z' }],
  ['Call HMRC by Friday', { title: 'Call HMRC', due: '2026-10-23' }],
  ['Do taxes @sam', { title: 'Do taxes', who: 'sam' }],
  ['Do taxes for samuel', { title: 'Do taxes for samuel' }],
  [
    'Birthday for Sam 5 Nov',
    {
      title: 'Birthday',
      kind: 'fixed',
      due: '2026-11-05',
      rrule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYMONTHDAY=5',
      lead: 14,
      who: 'sam',
      template: 'birthday',
    },
  ],
  ['Dentist the day before 20/11', { title: 'Dentist', due: '2026-11-20', offset: -1 }],
  [
    'Order cake, then collect 3/12 4:45 pm',
    { title: 'Order cake, then collect', due: '2026-12-03T16:45:00.000Z' },
  ],
  [
    'Clean oven once a month',
    {
      title: 'Clean oven',
      kind: 'fixed',
      due: '2026-10-17',
      rrule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=17',
    },
  ],
  [
    'Defrost freezer every 6 months',
    {
      title: 'Defrost freezer',
      kind: 'fixed',
      due: '2026-10-17',
      rrule: 'FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=17',
    },
  ],
  ['Pay for school trip due on 12/11', { title: 'Pay for school trip', due: '2026-11-12' }],
];

describe('quick-add corpus', () => {
  it('has the ~80 examples the plan asks for', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(80);
  });

  it.each(CORPUS)('%s', (text, expected) => {
    const parse = parseQuickAdd(text, context());
    const { task } = parse;

    expect({
      title: task.title,
      kind: task.scheduleKind,
      due: task.dueDate ?? task.dueAt,
      rrule: task.rrule,
      days: task.intervalAfterCompletionDays,
      lead: task.leadTimeDays,
      offset: task.remindOffsetDays,
      slot: task.reminderSlot,
      assignees: task.assigneeIds,
      template: parse.template?.id,
    }).toEqual({
      title: expected.title,
      kind: expected.kind ?? 'once',
      due: expected.due,
      rrule: expected.rrule,
      days: expected.days,
      lead: expected.lead,
      offset: expected.offset ?? 0,
      slot: expected.slot ?? 'evening',
      assignees: expected.who ? [MEMBER_IDS[expected.who]] : [],
      template: expected.template,
    });

    // Timed tasks have no date and all-day ones no instant.
    expect(task.allDay).toBe(task.dueAt === undefined);
    // The api would accept it as it is.
    const checked = taskBodySchema.safeParse(task);
    expect(checked.error?.issues).toBeUndefined();
    // What it says it understood is really in the text, in order, and not overlapping.
    let end = 0;
    for (const m of parse.matched) {
      expect(text.slice(m.start, m.end)).toBe(m.text);
      expect(m.start).toBeGreaterThanOrEqual(end);
      end = m.end;
    }
    // The confirmation card can always be drawn.
    expect(describeQuickAdd(parse, { members: MEMBERS, timezone: TZ, now: NOW })[0]?.label).toBe(
      'When',
    );
  });
});
