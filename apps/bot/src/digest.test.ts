import type { Agenda, AgendaItem } from '@tracker/db';
import { describe, expect, it } from 'vitest';
import { renderMorningDigest, renderWeekAhead } from './digest.js';
import { TELEGRAM_MESSAGE_LIMIT } from './render.js';

const ZONE = 'Europe/London';
// Monday 2 Nov 2026 (GMT).
const TODAY = '2026-11-02';

let seq = 0;

/** An open job due today, all-day and assigned to Alex, unless the overrides say otherwise. */
function job(title: string, overrides: Partial<AgendaItem> = {}): AgendaItem {
  seq += 1;
  return {
    occurrenceId: `occ-${seq}`,
    taskId: `task-${seq}`,
    title,
    dueDate: TODAY,
    dueAt: null,
    startAt: null,
    status: 'active',
    assigneeId: 'alex',
    assigneeName: 'Alex',
    effortMinutes: null,
    overdue: false,
    startingSoon: false,
    ...overrides,
  };
}

const agenda = (
  items: AgendaItem[],
  holidays: Agenda['holidays'] = [],
  truncated = false,
): Agenda => ({
  today: TODAY,
  items,
  truncated,
  holidays,
});

const holiday = (date: string, title: string): Agenda['holidays'][number] => ({
  region: 'england-and-wales',
  date,
  title,
});

describe('renderMorningDigest', () => {
  it('lists overdue, today and starting soon, then the bank holidays', () => {
    const text = renderMorningDigest(
      agenda(
        [
          job('Clean the gutters', { dueDate: '2026-10-30', overdue: true, assigneeName: 'Sam' }),
          job('Call the plumber', {
            dueDate: null,
            dueAt: new Date('2026-11-02T09:00:00Z'),
            overdue: true,
          }),
          job('Put the bins out', { dueDate: null, dueAt: new Date('2026-11-02T18:30:00Z') }),
          job('Water the plants', { assigneeId: null, assigneeName: null }),
          job('Renew the car tax', {
            dueDate: '2026-11-12',
            startAt: new Date('2026-11-01T00:00:00Z'),
          }),
          job('Book the MOT', {
            dueDate: '2026-11-20',
            startAt: new Date('2026-11-05T00:00:00Z'),
            startingSoon: true,
          }),
          job('Sort the loft', { dueDate: null }),
        ],
        [holiday('2026-11-05', 'Test holiday')],
      ),
      ZONE,
    );

    expect(text).toMatchInlineSnapshot(`
      "☀️ Mon 2 Nov

      Overdue
      • Clean the gutters — Sam (3 days overdue)
      • Call the plumber — Alex (was due 09:00)

      Today
      • Put the bins out — Alex (due 18:30)
      • Water the plants — Anyone
      • Renew the car tax — Alex (due Thu 12 Nov)
      • Sort the loft — Alex

      Starting soon
      • Book the MOT — Alex (starts Thu)

      Bank holiday Thu 5 Nov: Test holiday. Bin collection may be a day late."
    `);
  });

  it('is null when there is nothing on', () => {
    expect(renderMorningDigest(agenda([], [holiday(TODAY, 'Bank holiday')]), ZONE)).toBeNull();
  });

  it('leaves out an empty section', () => {
    expect(renderMorningDigest(agenda([job('Hoover')]), ZONE)).toMatchInlineSnapshot(`
      "☀️ Mon 2 Nov

      Today
      • Hoover — Alex"
    `);
  });

  it('shows a bank holiday today, the way the digest always has', () => {
    expect(
      renderMorningDigest(agenda([job('Hoover')], [holiday(TODAY, 'Summer bank holiday')]), ZONE),
    ).toMatchInlineSnapshot(`
      "☀️ Mon 2 Nov

      Today
      • Hoover — Alex

      Bank holiday Mon 2 Nov: Summer bank holiday. Bin collection may be a day late."
    `);
  });

  it('cuts names, defuses mentions and uses no markup', () => {
    const text = renderMorningDigest(
      agenda([
        job('Ask @bob about <b>the</b> & "bins"', { assigneeName: 'N'.repeat(100) }),
        job('T'.repeat(300)),
      ]),
      ZONE,
    );
    // The cut name and title end in "…", the "@" is followed by a zero-width space.
    expect(text).toBe(
      [
        '☀️ Mon 2 Nov',
        '',
        'Today',
        `• Ask @\u200bbob about <b>the</b> & "bins" — ${'N'.repeat(39)}…`,
        `• ${'T'.repeat(119)}… — Alex`,
      ].join('\n'),
    );
    expect(text).not.toMatch(/@(?!\u200b)/);
  });

  it('says there is more when the agenda was cut short', () => {
    const text = renderMorningDigest(agenda([job('Put the bins out')], [], true), ZONE);

    expect(text).toBe(
      '☀️ Mon 2 Nov\n\nToday\n• Put the bins out — Alex\n\n…and more — see the app',
    );
  });

  it('leaves out the last jobs, and says how many, when they do not fit', () => {
    const jobs = Array.from({ length: 50 }, (_, i) => job(`Job ${i} ${'x'.repeat(110)}`));
    const text = renderMorningDigest(
      agenda(jobs, [holiday('2026-11-04', 'Test holiday')]),
      ZONE,
    ) as string;

    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    const shown = text.split('\n').filter((l) => l.startsWith('• ')).length;
    expect(shown).toBeLessThan(50);
    expect(text).toContain(`…and ${50 - shown} more — see the app`);
    expect(text).toContain('Bank holiday Wed 4 Nov: Test holiday. Bin collection');
    expect(text.indexOf('…and')).toBeLessThan(text.indexOf('Bank holiday'));
  });
});

describe('renderWeekAhead', () => {
  it('lists overdue jobs, then a block for each day with jobs or a bank holiday', () => {
    const text = renderWeekAhead(
      agenda(
        [
          job('Clean the gutters', { dueDate: '2026-10-30', overdue: true }),
          job('Put the bins out'),
          job('Sort the loft', { dueDate: null }),
          job('Service the boiler', { dueDate: null, dueAt: new Date('2026-11-04T10:30:00Z') }),
          job('Book the MOT', {
            dueDate: '2026-11-20',
            startAt: new Date('2026-11-06T00:00:00Z'),
            startingSoon: true,
            assigneeName: null,
          }),
          job('Renew the car tax', {
            dueDate: '2026-11-12',
            startAt: new Date('2026-11-01T00:00:00Z'),
          }),
        ],
        [holiday('2026-11-04', 'Test holiday'), holiday('2026-11-07', 'Another holiday')],
      ),
      ZONE,
    );

    expect(text).toMatchInlineSnapshot(`
      "📅 Week ahead

      Overdue
      • Clean the gutters — Alex (3 days overdue)

      Mon 2 Nov
      • Put the bins out — Alex
      • Sort the loft — Alex
      • Renew the car tax — Alex (due Thu 12 Nov)

      Wed 4 Nov
      • Service the boiler — Alex (due 10:30)
      Bank holiday: Test holiday. Bin collection may be a day late.

      Fri 6 Nov
      • Book the MOT — Anyone (can start)

      Sat 7 Nov
      Bank holiday: Another holiday. Bin collection may be a day late."
    `);
  });

  it('puts the year on a day in the next year', () => {
    const text = renderWeekAhead(
      {
        today: '2026-12-30',
        items: [job('Hoover', { dueDate: '2027-01-02' })],
        truncated: false,
        holidays: [],
      },
      ZONE,
    );
    expect(text).toMatchInlineSnapshot(`
      "📅 Week ahead

      Sat 2 Jan 2027
      • Hoover — Alex"
    `);
  });

  it('takes the heading it is given', () => {
    expect(renderWeekAhead(agenda([job('Hoover')]), ZONE, '📅 Sam: next 7 days')).toMatch(
      /^📅 Sam: next 7 days\n/,
    );
  });

  it('is null when there is nothing on', () => {
    expect(renderWeekAhead(agenda([]), ZONE)).toBeNull();
  });

  it('stays within a message, and says how many jobs it left out', () => {
    const jobs = Array.from({ length: 50 }, (_, i) =>
      job(`Job ${i} ${'x'.repeat(110)}`, { dueDate: `2026-11-0${(i % 6) + 2}` }),
    );
    const text = renderWeekAhead(agenda(jobs), ZONE) as string;

    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    const shown = text.split('\n').filter((l) => l.startsWith('• ')).length;
    expect(text.endsWith(`…and ${50 - shown} more — see the app`)).toBe(true);
    // Never ends on a day title with nothing under it.
    expect(text.split('\n').at(-3)).toMatch(/^•/);
  });

  it('only ever leaves out jobs: the bank holidays stay, and every missing job is counted', () => {
    const jobs = Array.from({ length: 50 }, (_, i) =>
      job(`Job ${i} ${'x'.repeat(110)}`, { dueDate: `2026-11-0${(i % 6) + 2}` }),
    );
    // The last day of the week has only a bank holiday; the one on the 7th comes after its jobs.
    const text = renderWeekAhead(
      agenda(jobs, [holiday('2026-11-07', 'Test holiday'), holiday('2026-11-08', 'Last holiday')]),
      ZONE,
    ) as string;

    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    const shown = text.split('\n').filter((l) => l.startsWith('• ')).length;
    expect(shown).toBeLessThan(50);
    expect(text).toContain(`…and ${50 - shown} more — see the app`);
    expect(text).toContain('Sat 7 Nov\n');
    expect(text).toContain('Bank holiday: Test holiday. Bin collection');
    expect(text).toContain('Sun 8 Nov\nBank holiday: Last holiday. Bin collection');
  });

  it('drops a day block that has lost all its jobs and has no bank holiday', () => {
    // Overdue jobs come first, so they are the last to go; the later day's job is cut first.
    const overdue = Array.from({ length: 30 }, (_, i) =>
      job(`Late ${i} ${'x'.repeat(110)}`, { overdue: true, dueDate: '2026-10-30' }),
    );
    const text = renderWeekAhead(
      agenda([...overdue, job('Wednesday job', { dueDate: '2026-11-04' })]),
      ZONE,
    ) as string;

    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(text).not.toContain('Wed 4 Nov');
    expect(text).not.toContain('Wednesday job');
    expect(text).toMatch(/…and \d+ more — see the app$/);
  });

  it('says there is more when the agenda was cut short, even though everything it holds fits', () => {
    const jobs = [job('Put the bins out'), job('Water the plants')];

    const text = renderWeekAhead(agenda(jobs, [], true), ZONE) as string;

    expect(text.endsWith('\n\n…and more — see the app')).toBe(true);
    expect(text).not.toContain('…and 0');
    // A complete agenda has no tail.
    expect(renderWeekAhead(agenda(jobs), ZONE)).not.toContain('see the app');
  });

  it('counts only what it left out itself, as a lower bound, when the agenda was also cut short', () => {
    const jobs = Array.from({ length: 50 }, (_, i) => job(`Job ${i} ${'x'.repeat(110)}`));
    const text = renderMorningDigest(agenda(jobs, [], true), ZONE) as string;

    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    const shown = text.split('\n').filter((l) => l.startsWith('• ')).length;
    expect(text.endsWith(`…and ${50 - shown}+ more — see the app`)).toBe(true);
  });
});
