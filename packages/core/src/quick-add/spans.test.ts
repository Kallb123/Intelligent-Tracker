import { describe, expect, it } from 'vitest';
import { blank, cleanTitle } from './spans.js';

describe('blank', () => {
  it('replaces spans with spaces so offsets stay valid', () => {
    expect(blank('pay 1/11 now', [{ start: 4, end: 8 }])).toBe('pay      now');
    expect(
      blank('abcdef', [
        { start: 0, end: 2 },
        { start: 4, end: 6 },
      ]),
    ).toBe('  cd  ');
    expect(blank('abc', [])).toBe('abc');
  });
});

describe('cleanTitle', () => {
  it('tidies whitespace only when nothing was removed', () => {
    expect(cleanTitle('  Pay   the   bill ', false)).toBe('Pay the bill');
    expect(cleanTitle('On call rota,', false)).toBe('On call rota,');
    expect(cleanTitle('Ask what to look for', false)).toBe('Ask what to look for');
  });

  it('drops connectors and punctuation left dangling by what was removed', () => {
    expect(cleanTitle('Car insurance renews   ,       ', true)).toBe('Car insurance renews');
    expect(cleanTitle('MOT due   , ', true)).toBe('MOT');
    expect(cleanTitle('Call HMRC by ', true)).toBe('Call HMRC');
    expect(cleanTitle('Pay rent on at ', true)).toBe('Pay rent');
    expect(cleanTitle(', and then renew', true)).toBe('renew');
    expect(cleanTitle('Order cake ,  , then collect', true)).toBe('Order cake, then collect');
  });

  it('keeps words inside the title', () => {
    expect(cleanTitle('Pay in cash on delivery', true)).toBe('Pay in cash on delivery');
  });

  it('can end up empty', () => {
    expect(cleanTitle('      ', true)).toBe('');
    expect(cleanTitle(' , on ', true)).toBe('');
  });
});
