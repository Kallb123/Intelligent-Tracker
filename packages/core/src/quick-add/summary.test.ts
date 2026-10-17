import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from './parse.js';
import { describeQuickAdd } from './summary.js';
import { context, MEMBERS, NOW, TZ } from './test-util.js';

const rows = (text: string, now = NOW) => {
  const parse = parseQuickAdd(text, context({ now }));
  return describeQuickAdd(parse, { members: MEMBERS, timezone: TZ, now });
};
const asObject = (text: string) => Object.fromEntries(rows(text).map((r) => [r.label, r.value]));

describe('describeQuickAdd', () => {
  it('describes the worked example', () => {
    expect(rows('Car insurance renews 1/11 every year, sort it a month before')).toEqual([
      { label: 'When', value: 'Sun 1 Nov' },
      { label: 'Repeats', value: 'Every year on 1 November' },
      { label: 'Prep starts', value: '30 days before (Fri 2 Oct)' },
      {
        label: 'Milestones',
        value: 'Get quotes (30 days before), Decide (14 days before), Renew (7 days before)',
      },
      { label: 'Template', value: 'Car insurance renewal' },
    ]);
  });

  it('says "No date" and nothing else for a bare title', () => {
    expect(rows('Buy milk')).toEqual([{ label: 'When', value: 'No date' }]);
  });

  it('adds the year when the date is not this year', () => {
    expect(asObject('MOT 14/03')['When']).toBe('Sun 14 Mar 2027');
    expect(asObject('Pay 25 Dec')['When']).toBe('Fri 25 Dec');
  });

  it('shows a timed task in the household zone', () => {
    expect(asObject('Dentist 24/10 at 09:00')['When']).toBe('Sat 24 Oct at 09:00');
    expect(asObject('Dentist 26/10 at 09:00')['When']).toBe('Mon 26 Oct at 09:00');
  });

  it('describes repeats, including after completion', () => {
    expect(asObject('Gym every Monday and Thursday')['Repeats']).toBe(
      'Every week on Monday and Thursday',
    );
    expect(asObject('Clean filter every 6 weeks after done')['Repeats']).toBe(
      "Every 6 weeks after it's done",
    );
    expect(asObject('Pay rent last Friday of the month')['Repeats']).toBe(
      'Every month on the last Friday',
    );
    expect(asObject('Pay 1/11')['Repeats']).toBeUndefined();
  });

  it('describes lead time without a date, and singular days', () => {
    expect(asObject('renew something 1 day before')['Prep starts']).toBe('1 day before');
    expect(asObject('renew something 1 day before 3/11')['Prep starts']).toBe(
      '1 day before (Mon 2 Nov)',
    );
  });

  it('describes the reminder when it is not the default evening of the day', () => {
    expect(asObject('Bins every Tuesday, remind me the night before')['Reminder']).toBe(
      'Evening, 1 day before',
    );
    expect(asObject('Bins every Tuesday, ping me the morning before')['Reminder']).toBe(
      'Morning, 1 day before',
    );
    expect(asObject('Pay 1/11')['Reminder']).toBeUndefined();
  });

  it('describes a custom reminder time, working days and who it is for', () => {
    const parse = parseQuickAdd('Take bins out for Sam on Friday', context());
    const custom = {
      ...parse,
      task: {
        ...parse.task,
        reminderSlot: 'custom_time' as const,
        reminderCustomTime: '07:30',
        workingDaysOnly: true,
      },
    };
    const byLabel = Object.fromEntries(
      describeQuickAdd(custom, { members: MEMBERS, timezone: TZ, now: NOW }).map((r) => [
        r.label,
        r.value,
      ]),
    );
    expect(byLabel).toMatchObject({
      Reminder: 'At 07:30, 1 day before',
      'Working days only': 'Yes',
      For: 'Sam Jones',
      Template: 'Bin night',
    });
    const noTime = { ...custom, task: { ...custom.task, reminderCustomTime: undefined } };
    expect(
      describeQuickAdd(noTime, { members: MEMBERS, timezone: TZ, now: NOW }).find(
        (r) => r.label === 'Reminder',
      )?.value,
    ).toBe('At, 1 day before');
  });

  it('leaves out an assignee who is not in the member list', () => {
    const parse = parseQuickAdd('Wash up for Sam', context());
    expect(
      describeQuickAdd(parse, { members: [], timezone: TZ, now: NOW }).map((r) => r.label),
    ).toEqual(['When']);
  });
});
