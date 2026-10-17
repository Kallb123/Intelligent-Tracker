import { describe, expect, it } from 'vitest';
import {
  editInAppUrl,
  quickAddKeyboard,
  renderQuickAddCancelled,
  renderQuickAddCard,
  renderQuickAddFailed,
  renderQuickAddSaved,
} from './quick-add-card.js';

const ID = '3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c';
const BASE = 'https://tracker.example';

describe('renderQuickAddCard', () => {
  it('shows the title, then one line per row', () => {
    expect(
      renderQuickAddCard('Bins', [
        { label: 'When', value: 'Tue 3 Nov' },
        { label: 'For', value: 'Alex' },
      ]),
    ).toBe('Add this job?\n\nBins\nWhen: Tue 3 Nov\nFor: Alex');
  });

  it('defuses every @, in the title and in the rows, and leaves markup alone', () => {
    const card = renderQuickAddCard('Ask @bob <b>', [{ label: 'For', value: '@sam & @jo' }]);
    expect(card).toBe('Add this job?\n\nAsk @\u200bbob <b>\nFor: @\u200bsam & @\u200bjo');
  });

  it('keeps the whole card well inside Telegram’s 4096 characters, whatever the rows hold', () => {
    const rows = [
      'When',
      'Repeats',
      'Prep starts',
      'Milestones',
      'Reminder',
      'Working',
      'For',
      'Template',
    ].map((label) => ({ label, value: 'y'.repeat(2000) }));
    expect(renderQuickAddCard('x'.repeat(500), rows).length).toBeLessThan(4096);
  });
});

describe('the outcomes', () => {
  it('says what was added, for whom, and where to find it when the app’s address is known', () => {
    const task = { id: ID, title: 'Ask @bob' };
    expect(renderQuickAddSaved(task, ['Alex', '@sam'], undefined)).toBe(
      '✅ Added "Ask @\u200bbob" for Alex, @\u200bsam.',
    );
    expect(renderQuickAddSaved(task, ['Alex'], BASE)).toBe(
      `✅ Added "Ask @\u200bbob" for Alex.\n${BASE}/tasks/${ID}`,
    );
  });

  it('says what was cancelled, or could not be added', () => {
    expect(renderQuickAddCancelled('Bins')).toBe('✖️ Cancelled "Bins". Nothing was added.');
    expect(renderQuickAddFailed('Bins')).toBe('⚠️ I could not add "Bins". Send /add to try again.');
  });
});

describe('editInAppUrl', () => {
  it('opens the home page with the text in the quickAdd parameter, encoded', () => {
    expect(editInAppUrl(BASE, 'MOT due 14/03 & more?')).toBe(
      `${BASE}/?quickAdd=MOT%20due%2014%2F03%20%26%20more%3F`,
    );
  });

  it('cuts a text too long for a link, however it encodes, so the link stays valid', () => {
    for (const text of ['word '.repeat(2000), '🚗'.repeat(2000), 'é'.repeat(2000)]) {
      const url = editInAppUrl(BASE, text);
      expect(url.length).toBeLessThanOrEqual(1500);
      const param = new URL(url).searchParams.get('quickAdd') as string;
      expect(param.endsWith('…')).toBe(true);
      expect(text.startsWith(param.slice(0, -1).trimEnd())).toBe(true);
    }
  });

  it('does not touch a text that fits', () => {
    const text = 'x'.repeat(300);
    expect(new URL(editInAppUrl(BASE, text)).searchParams.get('quickAdd')).toBe(text);
  });
});

describe('quickAddKeyboard', () => {
  it('has Save and Cancel, carrying the draft’s id', () => {
    expect(quickAddKeyboard(ID, undefined)).toEqual([
      [
        { text: '✅ Save', callback_data: `qs:${ID}` },
        { text: '✖️ Cancel', callback_data: `qc:${ID}` },
      ],
    ]);
  });

  it('puts Edit in app, a plain link, between them when the app’s address is known', () => {
    expect(quickAddKeyboard(ID, { publicBaseUrl: BASE, text: 'Bins' })).toEqual([
      [
        { text: '✅ Save', callback_data: `qs:${ID}` },
        { text: '✏️ Edit in app', url: `${BASE}/?quickAdd=Bins` },
        { text: '✖️ Cancel', callback_data: `qc:${ID}` },
      ],
    ]);
  });
});
