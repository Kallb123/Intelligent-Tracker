import { describe, expect, it } from 'vitest';
import { renderDigest } from './digest.js';

describe('holiday digest', () => {
  it('shows cached bank holidays and a collection warning', () => {
    expect(
      renderDigest({
        today: '2026-08-31',
        items: [],
        holidays: [
          { region: 'england-and-wales', date: '2026-08-31', title: 'Summer bank holiday' },
        ],
      }),
    ).toBe(
      'Household digest — Mon 31 Aug\nNo active jobs today.\nBank holiday Mon 31 Aug: Summer bank holiday. Bin collection may be a day late.',
    );
  });
});
