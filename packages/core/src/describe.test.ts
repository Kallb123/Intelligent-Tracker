import { describe, expect, it } from 'vitest';
import { describeRecurrence, describeSchedule, ordinal } from './describe.js';
import { defaultRecurrence, type RecurrenceState } from './recurrence-form.js';

const words = (overrides: Partial<RecurrenceState>) =>
  describeRecurrence({ ...defaultRecurrence(), ...overrides });

describe('ordinal', () => {
  it('adds the right suffix', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '31st',
    ]);
  });
});

describe('describeRecurrence', () => {
  it('describes each pattern', () => {
    expect(words({ kind: 'daily' })).toBe('Every day');
    expect(words({ kind: 'daily', interval: 3 })).toBe('Every 3 days');
    expect(words({ kind: 'weekly', weekdays: ['MO'] })).toBe('Every week on Monday');
    expect(words({ kind: 'weekly', interval: 2, weekdays: ['MO', 'TH'] })).toBe(
      'Every 2 weeks on Monday and Thursday',
    );
    expect(words({ kind: 'weekly', weekdays: ['MO', 'WE', 'FR'] })).toBe(
      'Every week on Monday, Wednesday and Friday',
    );
    expect(words({ kind: 'monthly', monthDay: 2 })).toBe('Every month on the 2nd');
    expect(words({ kind: 'monthly', interval: 3, lastDay: true })).toBe(
      'Every 3 months on the last day',
    );
    expect(words({ kind: 'monthly', monthlyMode: 'weekday', nth: 2, nthWeekday: 'TU' })).toBe(
      'Every month on the 2nd Tuesday',
    );
    expect(words({ kind: 'monthly', monthlyMode: 'weekday', nth: -1, nthWeekday: 'FR' })).toBe(
      'Every month on the last Friday',
    );
    expect(words({ kind: 'yearly', month: 3, monthDay: 5 })).toBe('Every year on 5 March');
    expect(words({ kind: 'yearly', interval: 2, month: 2, lastDay: true })).toBe(
      'Every 2 years on the last day of February',
    );
    expect(words({ kind: 'custom', customRrule: 'FREQ=DAILY;COUNT=3' })).toBe(
      'Custom schedule (FREQ=DAILY;COUNT=3)',
    );
    expect(words({ kind: 'once' })).toBe('Once');
  });

  it('counts an after-completion gap in whole weeks where it can', () => {
    expect(words({ kind: 'after_completion', afterDays: 42 })).toBe(
      "Every 6 weeks after it's done",
    );
    expect(words({ kind: 'after_completion', afterDays: 7 })).toBe("Every week after it's done");
    expect(words({ kind: 'after_completion', afterDays: 10 })).toBe(
      "Every 10 days after it's done",
    );
    expect(words({ kind: 'after_completion', afterDays: 1 })).toBe("Every day after it's done");
  });
});

describe('describeSchedule', () => {
  const base = {
    scheduleKind: 'once',
    rrule: null,
    intervalAfterCompletionDays: null,
    allDay: true,
    dueDate: null,
    dueAt: null,
  } as const;

  it('describes one-offs with their date', () => {
    expect(describeSchedule({ ...base, dueDate: '2026-11-01' }, 'Europe/London')).toBe(
      'Once, 1 Nov 2026',
    );
    expect(describeSchedule(base, 'Europe/London')).toBe('Once, no date');
    expect(
      describeSchedule(
        { ...base, allDay: false, dueAt: '2026-11-01T14:30:00.000Z' },
        'Europe/London',
      ),
    ).toBe('Once, 1 Nov 2026 at 14:30');
    // The household's zone decides the date: 23:30 UTC is already tomorrow in Auckland.
    expect(
      describeSchedule(
        { ...base, allDay: false, dueAt: '2026-11-01T23:30:00.000Z' },
        'Pacific/Auckland',
      ),
    ).toBe('Once, 2 Nov 2026 at 12:30');
    expect(describeSchedule({ ...base, allDay: false }, 'Europe/London')).toBe('Once, no date');
  });

  it('describes repeating tasks from their rule', () => {
    expect(
      describeSchedule(
        {
          ...base,
          scheduleKind: 'fixed',
          rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO',
          dueDate: '2026-10-12',
        },
        'Europe/London',
      ),
    ).toBe('Every week on Monday');
    expect(
      describeSchedule(
        {
          ...base,
          scheduleKind: 'after_completion',
          intervalAfterCompletionDays: 42,
          dueDate: '2026-10-12',
        },
        'Europe/London',
      ),
    ).toBe("Every 6 weeks after it's done");
    expect(
      describeSchedule(
        { ...base, scheduleKind: 'fixed', rrule: 'FREQ=DAILY;COUNT=2', dueDate: '2026-10-12' },
        'Europe/London',
      ),
    ).toBe('Custom schedule (FREQ=DAILY;COUNT=2)');
  });
});
