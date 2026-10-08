import { describe, expect, it } from 'vitest';
import { extractJson } from '../src/json-extract';

describe('extractJson', () => {
  it.each([
    ['prose around the object', 'Sure! {"say":"hi","tool":null} Hope that helps.', { say: 'hi', tool: null }],
    ['a code fence', 'Here you go:\n```json\n{"say": "ok"}\n```', { say: 'ok' }],
    ['nested braces', 'x {"a":{"b":{"c":[1,{"d":2}]}},"e":3} y', { a: { b: { c: [1, { d: 2 }] } }, e: 3 }],
    ['braces inside strings', '{"say":"use {braces} and }{ freely","n":1}', { say: 'use {braces} and }{ freely', n: 1 }],
    ['escaped quotes and backslashes', '{"say":"she said \\"hi {\\" \\\\","n":1} {"n":2}', { say: 'she said "hi {" \\', n: 1 }],
    ['an invalid object before a valid one', '{say: hi} then {"say":"hi"}', { say: 'hi' }],
    ['a valid object inside an invalid one', '{"outer": oops {"inner": true}}', { inner: true }],
    ['a stray closing brace first', '} {"a":1}', { a: 1 }],
    ['two objects, returning the first', '{"a":1}{"b":2}', { a: 1 }],
  ])('finds the object in %s', (_, text, expected) => {
    expect(extractJson(text)).toEqual(expected);
  });

  it.each(['', 'no json here', '{"unterminated": "x"', '{not: json}', '[1, 2]'])(
    'returns undefined for %j',
    (text) => {
      expect(extractJson(text)).toBeUndefined();
    },
  );
});
