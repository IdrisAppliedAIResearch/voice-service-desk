import { describe, expect, it } from 'vitest';
import { natoSpell } from '../src/nato';

describe('natoSpell', () => {
  it.each([
    ['mchen2', 'Mike Charlie Hotel Echo November Two'],
    ['j.doe-x_9', 'Juliet Dot Delta Oscar Echo Dash X-ray Underscore Nine'],
    ['AB0', 'Alpha Bravo Zero'],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(natoSpell(input)).toBe(expected);
  });

  it('has a distinct word for every letter and digit', () => {
    const letters = natoSpell('abcdefghijklmnopqrstuvwxyz').split(' ');
    expect(new Set(letters).size).toBe(26);
    expect(letters.every((w) => /^[A-Z][a-z-]+$/.test(w))).toBe(true);
    expect(natoSpell('0123456789')).toBe('Zero One Two Three Four Five Six Seven Eight Nine');
  });
});
