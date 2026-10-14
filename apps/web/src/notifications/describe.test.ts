import type { ReminderPayload } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { describeReminder } from './describe.js';

const payload = (overrides: Partial<ReminderPayload>): ReminderPayload => ({
  type: 'reminder',
  kind: 'due',
  taskId: '33333333-3333-4333-8333-333333333333',
  occurrenceId: '44444444-4444-4444-8444-444444444444',
  taskTitle: 'Car insurance',
  dueDate: '2026-11-01',
  dueAt: null,
  fireAt: '2026-10-02T08:00:00.000Z',
  assigneeId: null,
  ...overrides,
});

const words = (overrides: Partial<ReminderPayload>) =>
  describeReminder(payload(overrides), 'Europe/London');

describe('describeReminder', () => {
  it('describes a heads-up with the due date', () => {
    expect(words({ kind: 'heads_up' })).toBe('Coming up: Car insurance (due 1 Nov 2026)');
  });

  it('describes a milestone by its title', () => {
    expect(words({ kind: 'milestone', milestoneTitle: 'Get quotes' })).toBe(
      'Get quotes — Car insurance',
    );
    expect(words({ kind: 'milestone' })).toBe('Car insurance');
  });

  it('describes a nudge', () => {
    expect(words({ kind: 'nudge' })).toBe('Reminder: Car insurance is due 1 Nov 2026');
  });

  describe('a due reminder', () => {
    const onTheDay = { fireAt: '2026-11-01T19:00:00.000Z' };

    it('says today on the due day, with the time when timed', () => {
      expect(words({ kind: 'due', ...onTheDay })).toBe('Car insurance is due today');
      expect(
        words({ kind: 'due', dueDate: null, dueAt: '2026-11-01T18:30:00.000Z', ...onTheDay }),
      ).toBe('Car insurance is due today at 18:30');
    });

    it('says tomorrow when it fires the evening before, as for an early timed due', () => {
      expect(
        words({
          kind: 'due',
          dueDate: null,
          dueAt: '2026-11-01T14:00:00.000Z',
          fireAt: '2026-10-31T19:00:00.000Z',
        }),
      ).toBe('Car insurance is due tomorrow at 14:00');
      expect(words({ kind: 'due', fireAt: '2026-10-31T19:00:00.000Z' })).toBe(
        'Car insurance is due tomorrow',
      );
    });

    it('gives the date when a hold moved it to another day', () => {
      expect(words({ kind: 'due', fireAt: '2026-11-03T19:00:00.000Z' })).toBe(
        'Car insurance is due 1 Nov 2026',
      );
      expect(words({ kind: 'due', fireAt: '2026-10-25T19:00:00.000Z' })).toBe(
        'Car insurance is due 1 Nov 2026',
      );
      expect(
        words({
          kind: 'due',
          dueDate: null,
          dueAt: '2026-11-01T14:00:00.000Z',
          fireAt: '2026-11-03T19:00:00.000Z',
        }),
      ).toBe('Car insurance is due 1 Nov 2026 at 14:00');
    });

    it('compares days in the household time zone, not UTC', () => {
      // 23:30 UTC on 31 October is already 1 November in Auckland (NZDT, +13), the due day.
      const fireAt = '2026-10-31T23:30:00.000Z';
      expect(describeReminder(payload({ kind: 'due', fireAt }), 'Pacific/Auckland')).toBe(
        'Car insurance is due today',
      );
      expect(describeReminder(payload({ kind: 'due', fireAt }), 'Europe/London')).toBe(
        'Car insurance is due tomorrow',
      );
    });
  });

  it('describes an overdue reminder in days', () => {
    expect(words({ kind: 'overdue', overdueDays: 1 })).toBe('Car insurance is 1 day overdue');
    expect(words({ kind: 'overdue', overdueDays: 3 })).toBe('Car insurance is 3 days overdue');
    expect(words({ kind: 'overdue' })).toBe('Car insurance is overdue');
  });

  it('shows a timed due in the household time zone', () => {
    // 23:30 UTC on 30 June is already 00:30 on 1 July in London (BST).
    const timed = { dueDate: null, dueAt: '2026-06-30T23:30:00.000Z' };
    expect(words({ kind: 'nudge', ...timed })).toBe(
      'Reminder: Car insurance is due 1 Jul 2026 at 00:30',
    );
    expect(describeReminder(payload({ kind: 'nudge', ...timed }), 'America/New_York')).toBe(
      'Reminder: Car insurance is due 30 Jun 2026 at 19:30',
    );
  });

  it('leaves the date out when there is none', () => {
    expect(words({ kind: 'heads_up', dueDate: null })).toBe('Coming up: Car insurance');
    expect(words({ kind: 'nudge', dueDate: null })).toBe('Reminder: Car insurance');
  });
});
