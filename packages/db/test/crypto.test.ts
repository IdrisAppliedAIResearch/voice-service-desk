import { describe, expect, it } from 'vitest';
import { DUMMY_HASH, hashSecret, normalizeAnswer, verifySecret } from '../src/crypto';

describe('normalizeAnswer', () => {
  it.each([
    ['  St. Louis  ', 'st louis'],
    ["O'Brien", 'obrien'],
    ['O’Brien', 'obrien'],
    ['Maple   -  Street', 'maple street'],
    ['Ｈｏｎｄａ　Ｃｉｖｉｃ！', 'honda civic'],
    ['Café Olé', 'café olé'],
    ['Line\tbreak\nand space', 'line break and space'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeAnswer(input)).toBe(expected);
  });
});

describe('hashSecret and verifySecret', () => {
  it('accepts only the matching normalized answer', async () => {
    const hash = await hashSecret(normalizeAnswer('St. Louis'));
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifySecret(hash, normalizeAnswer('  st louis'))).toBe(true);
    expect(await verifySecret(hash, normalizeAnswer('Chicago'))).toBe(false);
    expect(await verifySecret(hash, '')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashSecret('123456')).not.toBe(await hashSecret('123456'));
  });

  it('returns false for a malformed hash instead of throwing', async () => {
    for (const bad of ['', 'not-a-hash', '$argon2id$v=19$m=19456,t=2,p=1$bad']) {
      expect(await verifySecret(bad, 'st louis')).toBe(false);
    }
  });

  it('DUMMY_HASH is a real argon2id hash that matches nothing a caller says', async () => {
    expect(DUMMY_HASH.startsWith('$argon2id$')).toBe(true);
    expect(await verifySecret(DUMMY_HASH, '')).toBe(false);
    expect(await verifySecret(DUMMY_HASH, 'st louis')).toBe(false);
  });
});
