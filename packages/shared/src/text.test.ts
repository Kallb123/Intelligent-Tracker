import { describe, expect, it } from 'vitest';
import { sliceWhole } from './text.js';

describe('sliceWhole', () => {
  it('leaves a text that fits alone', () => {
    expect(sliceWhole('abc', 3)).toBe('abc');
    expect(sliceWhole('', 0)).toBe('');
  });

  it('cuts a longer text at the limit', () => {
    expect(sliceWhole('abcdef', 4)).toBe('abcd');
  });

  it('drops a surrogate pair the cut would split', () => {
    expect(sliceWhole('ab😀cd', 3)).toBe('ab');
    expect(sliceWhole('ab😀cd', 4)).toBe('ab😀');
    expect(sliceWhole('😀😀', 1)).toBe('');
  });

  it('never ends in a lone surrogate', () => {
    for (let max = 0; max <= 12; max += 1) {
      const cut = sliceWhole('a😀b😀c😀d', max);
      expect(cut.length).toBeLessThanOrEqual(max);
      // `encodeURIComponent` throws on a lone surrogate.
      expect(() => encodeURIComponent(cut)).not.toThrow();
    }
  });
});
