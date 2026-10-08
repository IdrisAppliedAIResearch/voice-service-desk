const WORDS: Record<string, string> = {
  ...Object.fromEntries(
    'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey X-ray Yankee Zulu'
      .split(' ')
      .map((w) => [w[0].toLowerCase(), w]),
  ),
  ...Object.fromEntries('Zero One Two Three Four Five Six Seven Eight Nine'.split(' ').map((w, i) => [i, w])),
  '.': 'Dot',
  '-': 'Dash',
  _: 'Underscore',
};

export function natoSpell(s: string): string {
  return [...s.toLowerCase()].map((c) => WORDS[c] ?? c).join(' ');
}
