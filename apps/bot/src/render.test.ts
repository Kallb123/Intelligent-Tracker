import { snoozeOptions } from '@tracker/core';
import { DEFAULT_OUTBOX_MESSAGE_SIZE, type OccurrenceState } from '@tracker/db';
import type { ReminderPayload } from '@tracker/shared';
import { describe, expect, it } from 'vitest';
import { decodeCallback } from './callback-data.js';
import {
  escapeHtml,
  formatSnoozeUntil,
  MAX_LINE_LENGTH,
  renderMessage,
  snoozeChoices,
  TELEGRAM_MESSAGE_LIMIT,
  truncate,
  type RenderInput,
  type RenderLine,
} from './render.js';

const OCC_A = '11111111-1111-4111-8111-111111111111';
const OCC_B = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const ZONE = 'Europe/London';
// Monday 2 Nov 2026, 18:00 in London (GMT).
const NOW = new Date('2026-11-02T18:00:00Z');

function line(
  occurrenceId: string,
  overrides: Partial<ReminderPayload> = {},
  assignee: RenderLine['assignee'] = { name: 'Alex', telegramUserId: 1001 },
): RenderLine {
  return {
    assignee,
    payload: {
      type: 'reminder',
      kind: 'due',
      taskId: '44444444-4444-4444-8444-444444444444',
      occurrenceId,
      taskTitle: 'Put the bins out',
      dueDate: '2026-11-02',
      dueAt: null,
      fireAt: '2026-11-02T19:00:00Z',
      assigneeId: assignee ? MEMBER : null,
      ...overrides,
    },
  };
}

function open(occurrenceId: string, overrides: Partial<OccurrenceState> = {}): OccurrenceState {
  return { occurrenceId, status: 'active', snoozedUntil: null, actors: {}, ...overrides };
}

function render(lines: RenderLine[], states: OccurrenceState[], extra: Partial<RenderInput> = {}) {
  return renderMessage({
    lines,
    states: new Map(states.map((s) => [s.occurrenceId, s])),
    timeZone: ZONE,
    now: NOW,
    ...extra,
  });
}

describe('renderMessage', () => {
  it('renders one reminder without numbers, with the plain buttons and a mention', () => {
    const { text, keyboard } = render([line(OCC_A)], [open(OCC_A)]);

    expect(text).toBe('<a href="tg://user?id=1001">Alex</a>: Put the bins out is due today');
    expect(keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ['✅ Done', '▶️ Started', '⏰ Snooze', '⏭ Skip'],
    ]);
    expect(keyboard[0]?.map((b) => decodeCallback(b.callback_data))).toEqual([
      { type: 'complete', occurrenceId: OCC_A },
      { type: 'start', occurrenceId: OCC_A },
      { type: 'snoozeMenu', occurrenceId: OCC_A },
      { type: 'skip', occurrenceId: OCC_A },
    ]);
  });

  it('numbers several reminders and labels each occurrence row with its line number', () => {
    const { text, keyboard } = render(
      [
        line(OCC_A),
        line(
          OCC_B,
          { taskTitle: 'Water the plants', kind: 'nudge' },
          { name: 'Sam', telegramUserId: null },
        ),
      ],
      [open(OCC_A), open(OCC_B)],
    );

    expect(text).toBe(
      [
        '1. <a href="tg://user?id=1001">Alex</a>: Put the bins out is due today',
        '2. Sam: Reminder: Water the plants is due 2 Nov 2026',
      ].join('\n\n'),
    );
    expect(keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ['✅ 1', '▶️ 1', '⏰ 1', '⏭ 1'],
      ['✅ 2', '▶️ 2', '⏰ 2', '⏭ 2'],
    ]);
  });

  it('shares one row between reminders of the same occurrence, with plain labels', () => {
    const { text, keyboard } = render(
      [line(OCC_A), line(OCC_A, { kind: 'overdue', overdueDays: 2 })],
      [open(OCC_A)],
    );

    expect(text).toContain('1. ');
    expect(text).toContain('2. ');
    expect(keyboard).toHaveLength(1);
    expect(keyboard[0]?.[0]?.text).toBe('✅ Done');
  });

  it('labels rows by the first line of their occurrence when others share rows', () => {
    const { keyboard } = render(
      [line(OCC_A), line(OCC_A, { kind: 'overdue', overdueDays: 2 }), line(OCC_B)],
      [open(OCC_A), open(OCC_B)],
    );
    expect(keyboard.map((row) => row[0]?.text)).toEqual(['✅ 1', '✅ 3']);
  });

  it('says Anyone when there is no assignee', () => {
    const { text } = render([line(OCC_A, {}, null)], [open(OCC_A)]);
    expect(text).toBe('Anyone 🙋: Put the bins out is due today');
  });

  it('escapes HTML in titles and names', () => {
    const { text } = render(
      [line(OCC_A, { taskTitle: 'Fish & <chips>' }, { name: 'Tom <b>&</b>', telegramUserId: 7 })],
      [open(OCC_A)],
    );
    expect(text).toBe(
      '<a href="tg://user?id=7">Tom &lt;b&gt;&amp;&lt;/b&gt;</a>: Fish &amp; &lt;chips&gt; is due today',
    );
  });

  it('strikes a done line through, names who did it, and drops its buttons', () => {
    const { text, keyboard } = render(
      [line(OCC_A)],
      [open(OCC_A, { status: 'done', actors: { completed: 'Sam' } })],
    );

    expect(text).toBe('<s>Alex: Put the bins out is due today</s>\n✅ Done by Sam');
    expect(keyboard).toEqual([]);
  });

  it('strikes a skipped line through', () => {
    const { text, keyboard } = render(
      [line(OCC_A)],
      [open(OCC_A, { status: 'skipped', actors: { skipped: 'Sam' } })],
    );

    expect(text).toBe('<s>Alex: Put the bins out is due today</s>\n⏭ Skipped by Sam');
    expect(keyboard).toEqual([]);
  });

  it('leaves out the actor when it is not known', () => {
    const { text } = render(
      [line(OCC_A)],
      [open(OCC_A, { status: 'done', actors: { completed: null } })],
    );
    expect(text).toBe('<s>Alex: Put the bins out is due today</s>\n✅ Done');
  });

  it('shows a started line with its actor, without a Started button', () => {
    const { text, keyboard } = render(
      [line(OCC_A)],
      [open(OCC_A, { status: 'started', actors: { started: 'Sam <3' } })],
    );

    expect(text).toBe(
      '<a href="tg://user?id=1001">Alex</a>: Put the bins out is due today\n▶️ Started by Sam &lt;3',
    );
    expect(keyboard[0]?.map((b) => b.text)).toEqual(['✅ Done', '⏰ Snooze', '⏭ Skip']);
  });

  it('shows a snoozed line until when, in the household zone', () => {
    const { text, keyboard } = render(
      [line(OCC_A)],
      [
        open(OCC_A, {
          snoozedUntil: new Date('2026-11-03T19:00:00Z'),
          actors: { snoozed: 'Sam' },
        }),
      ],
    );

    expect(text).toBe(
      '<a href="tg://user?id=1001">Alex</a>: Put the bins out is due today\n⏰ Snoozed until Tue 19:00 by Sam',
    );
    expect(keyboard).toHaveLength(1);
  });

  it('ignores a snooze that has run out', () => {
    const { text } = render(
      [line(OCC_A)],
      [open(OCC_A, { snoozedUntil: new Date('2026-11-02T17:00:00Z'), actors: { snoozed: 'Sam' } })],
    );
    expect(text).toBe('<a href="tg://user?id=1001">Alex</a>: Put the bins out is due today');
  });

  it('prefers the snooze over a started status, and the zone decides the weekday', () => {
    const { text } = render(
      [line(OCC_A)],
      // 23:30 UTC on Tuesday in summer is already Wednesday 00:30 in London.
      [open(OCC_A, { status: 'started', snoozedUntil: new Date('2026-07-07T23:30:00Z') })],
      { now: new Date('2026-07-07T12:00:00Z') },
    );
    expect(text).toContain('⏰ Snoozed until Wed 00:30');
    expect(text).not.toContain('Started');
  });

  it('marks an occurrence that no longer exists as removed, without buttons', () => {
    const { text, keyboard } = render([line(OCC_A)], []);
    expect(text).toBe('<s>Alex: Put the bins out is due today</s>\n🗑 Removed');
    expect(keyboard).toEqual([]);
  });

  it('keeps the numbers and the labels of the other rows when one occurrence closes', () => {
    const { text, keyboard } = render(
      [line(OCC_A), line(OCC_B)],
      [open(OCC_A, { status: 'done', actors: { completed: 'Sam' } }), open(OCC_B)],
    );

    expect(text.split('\n\n')[0]).toBe(
      '1. <s>Alex: Put the bins out is due today</s>\n✅ Done by Sam',
    );
    expect(keyboard.map((row) => row[0]?.text)).toEqual(['✅ 2']);
  });

  it('replaces the row of the occurrence being snoozed with the choices and a way back', () => {
    const choices = snoozeChoices(
      snoozeOptions({ now: NOW, timezone: ZONE, eveningSlot: '19:00:00' }),
    );
    const { keyboard } = render([line(OCC_A), line(OCC_B)], [open(OCC_A), open(OCC_B)], {
      snoozeMenu: { occurrenceId: OCC_B, choices },
    });

    expect(keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ['✅ 1', '▶️ 1', '⏰ 1', '⏭ 1'],
      ['Tonight', 'Tomorrow', 'Weekend', '3 days'],
      ['↩ Back'],
    ]);
    expect(keyboard[1]?.map((b) => decodeCallback(b.callback_data))).toEqual([
      { type: 'snooze', key: 'tonight', occurrenceId: OCC_B },
      { type: 'snooze', key: 'tomorrow', occurrenceId: OCC_B },
      { type: 'snooze', key: 'weekend', occurrenceId: OCC_B },
      { type: 'snooze', key: '3d', occurrenceId: OCC_B },
    ]);
    expect(decodeCallback(keyboard[2]?.[0]?.callback_data ?? '')).toEqual({
      type: 'back',
      occurrenceId: OCC_B,
    });
  });

  it('never exceeds the 64 bytes Telegram allows in button data', () => {
    const choices = snoozeChoices(
      snoozeOptions({ now: NOW, timezone: ZONE, eveningSlot: '19:00' }),
    );
    const plain = render([line(OCC_A)], [open(OCC_A)]);
    const menu = render([line(OCC_A)], [open(OCC_A)], {
      snoozeMenu: { occurrenceId: OCC_A, choices },
    });
    for (const button of [...plain.keyboard.flat(), ...menu.keyboard.flat()]) {
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    }
  });
});

/** What Telegram counts: the text with the tags dropped and the entities decoded. */
function visibleLength(html: string): number {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').length;
}

describe('message length', () => {
  // Every character that is an entity once escaped, as long as the schemas allow.
  const title = '&<>'.repeat(66).slice(0, 200);
  const longName = '<&>'.repeat(26).slice(0, 80);
  const full = Array.from({ length: DEFAULT_OUTBOX_MESSAGE_SIZE }, (_, i) => i);
  const futureSnooze = new Date('2026-11-03T19:00:00Z');

  const states: [string, (id: string) => OccurrenceState | undefined][] = [
    ['open', (id) => open(id)],
    ['done', (id) => open(id, { status: 'done', actors: { completed: longName } })],
    ['skipped', (id) => open(id, { status: 'skipped', actors: { skipped: longName } })],
    ['started', (id) => open(id, { status: 'started', actors: { started: longName } })],
    ['snoozed', (id) => open(id, { snoozedUntil: futureSnooze, actors: { snoozed: longName } })],
    ['removed', () => undefined],
  ];

  it.each(states)('fits a full batch of the longest lines in Telegram (%s)', (_name, state) => {
    for (const kind of ['milestone', 'heads_up', 'nudge', 'due', 'overdue'] as const) {
      const lines = full.map((i) =>
        line(
          `00000000-0000-4000-8000-00000000000${i}`,
          { kind, taskTitle: title, milestoneTitle: title, overdueDays: 100, dueAt: null },
          { name: longName, telegramUserId: 1000 + i },
        ),
      );
      const { text } = render(
        lines,
        lines.flatMap((l) => state(l.payload.occurrenceId) ?? []),
      );

      expect(visibleLength(text)).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      // The longest text (milestone title and task title together) is the one that gets cut.
      if (kind === 'milestone') expect(text).toContain('…');
    }
  });

  it('fits a full batch where every line is in a different state', () => {
    const lines = full.map((i) =>
      line(
        `00000000-0000-4000-8000-00000000000${i}`,
        { kind: 'milestone', taskTitle: title, milestoneTitle: title },
        { name: longName, telegramUserId: 1000 + i },
      ),
    );
    const { text } = render(
      lines,
      lines.flatMap((l, i) => states[i % states.length]?.[1](l.payload.occurrenceId) ?? []),
    );
    expect(visibleLength(text)).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
  });

  it('keeps every line within its budget and escapes the cut text whole', () => {
    const { text } = render(
      [line(OCC_A, { taskTitle: title }, { name: longName, telegramUserId: 7 })],
      [open(OCC_A, { status: 'started', actors: { started: longName } })],
    );

    expect(visibleLength(text)).toBeLessThanOrEqual(MAX_LINE_LENGTH);
    expect(text).toContain('…');
    // No entity was cut in two: every "&" starts a whole one.
    expect(text.match(/&(?!amp;|lt;|gt;)/g)).toBeNull();
    // The name is shortened too.
    expect(text).not.toContain(longName);
  });

  it('leaves text that fits untouched', () => {
    const { text } = render([line(OCC_A)], [open(OCC_A)]);
    expect(text).not.toContain('…');
  });
});

describe('truncate', () => {
  it('returns text that fits as it is', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });

  it('cuts to the length with an ellipsis and drops the space before it', () => {
    expect(truncate('hello world', 7)).toBe('hello…');
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
  });

  it('never splits a surrogate pair', () => {
    // "ab😀cd": the emoji is two UTF-16 units at index 2-3.
    expect(truncate('ab😀cd', 4)).toBe('ab…');
    expect(truncate('ab😀cd', 5)).toBe('ab😀…');
    expect(truncate('😀'.repeat(10), 7).length).toBeLessThanOrEqual(7);
  });
});

describe('snoozeChoices', () => {
  it('offers all four from Monday evening before the slot', () => {
    const options = snoozeOptions({ now: NOW, timezone: ZONE, eveningSlot: '19:00' });
    expect(snoozeChoices(options).map((c) => c.key)).toEqual([
      'tonight',
      'tomorrow',
      'weekend',
      '3d',
    ]);
  });

  it('drops Tonight once the slot has passed (as the options do)', () => {
    const options = snoozeOptions({
      now: new Date('2026-11-02T20:00:00Z'),
      timezone: ZONE,
      eveningSlot: '19:00',
    });
    expect(snoozeChoices(options).map((c) => c.key)).toEqual(['tomorrow', 'weekend', '3d']);
  });

  it('drops Weekend when it is the same as Tomorrow (on a Friday)', () => {
    const options = snoozeOptions({
      now: new Date('2026-11-06T12:00:00Z'),
      timezone: ZONE,
      eveningSlot: '19:00',
    });
    expect(snoozeChoices(options).map((c) => c.key)).toEqual(['tonight', 'tomorrow', '3d']);
  });
});

describe('escapeHtml and formatSnoozeUntil', () => {
  it('escapes the three characters Telegram HTML cares about', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d "e"');
  });

  it('formats a deadline as weekday and time in the zone', () => {
    expect(formatSnoozeUntil(new Date('2026-07-07T18:00:00Z'), ZONE)).toBe('Tue 19:00');
  });
});
