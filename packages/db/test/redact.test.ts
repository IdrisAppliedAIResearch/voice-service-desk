import { describe, expect, it } from 'vitest';
import { maskEmail, maskPhone, redactDetail, redactText } from '../src/redact';

describe('redactText', () => {
  it.each([
    ['my code is 123456', 'my code is [code]'],
    ['it is 1 2 3 4 5 6.', 'it is [code].'],
    ['pin 123-456 please', 'pin [code] please'],
    ['codes 111111 and 222222', 'codes [code] and [code]'],
    ['ticket 10001', 'ticket 10001'],
    ['call 1234567', 'call 1234567'],
    ['digits 1 2 3 4 5 6 7', 'digits 1 2 3 4 5 6 7'],
    ['phone 555-123-4567', 'phone 555-123-4567'],
    ['employee E 1 2 3 4 5', 'employee E 1 2 3 4 5'],
    ['mail jane.doe@contoso-health.example.', 'mail ja***.'],
    ['a@b.example and Bob.Smith+x@contoso-health.example', 'a@*** and Bo***'],
    ['write to x@10.0.0.1', 'write to x@***'],
    ['it is jane dot doe at contoso dash health dot example', 'it is ja***'],
    ['Mike underscore Chen at Contoso dot example, thanks', 'Mi***, thanks'],
    ['the printer at building two is down', 'the printer at building two is down'],
    // Mixed written and spoken forms, which the identifier parser also accepts.
    ['it is eleanor.whitaker at contoso-health.example', 'it is el***'],
    ['eleanor.whitaker at contoso dash health dot example', 'el***'],
    ['eleanor.whitaker@contoso dash health dot example', 'el***'],
    ['ELEANOR DOT WHITAKER AT CONTOSO-HEALTH DOT EXAMPLE', 'EL***'],
    ['meet at 10.30 in room 4', 'meet at 10.30 in room 4'],
    // Six digits typed or transcribed with digit words, commas, dots or extra spaces, which the PIN and code parsers accept.
    ['pin 482,913', 'pin [code]'],
    ['pin 482.913', 'pin [code]'],
    ['pin four eight two nine oh three', 'pin [code]'],
    ['PIN 4 8 2 9 Oh 3', 'PIN [code]'],
    ['pin four eight two, nine one three', 'pin [code]'],
    ['pin 4, 8, 2, 9, 1, 3 ok', 'pin [code] ok'],
    ['pin 4  8  2  9  1  3', 'pin [code]'],
    ['pin 482913, 2 tries left', 'pin [code], 2 tries left'],
    ['phone 555.123.4567', 'phone 555.123.4567'],
    ['call me at 555 123 4567', 'call me at 555 123 4567'],
    ['digits 1, 2, 3, 4, 5, 6, 7', 'digits 1, 2, 3, 4, 5, 6, 7'],
    ['one two three four five six seven', 'one two three four five six seven'],
    ['tickets 10001, 10002 and dates 2026-09-30', 'tickets 10001, 10002 and dates 2026-09-30'],
    ['someone phoned about one laptop', 'someone phoned about one laptop'],
  ])('%j -> %j', (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it('redacts the whole utterance when fully is set', () => {
    expect(redactText('St. Louis', { fully: true })).toBe('[redacted]');
  });
});

describe('redactDetail', () => {
  it('masks secret keys at any depth, redacts strings, and leaves the input untouched', () => {
    const at = new Date('2026-09-30T12:00:00Z');
    const input = {
      answer: 'St. Louis',
      text: 'reach me at bob@contoso-health.example, code 654321',
      nested: {
        pin: '123456',
        list: [{ otp: '1', Password: 'x', clientSecret: 'y', answer_hash: 'z', token: 't', code: 'c' }, 'code 111222'],
      },
      count: 3,
      ok: true,
      none: null,
      at,
    };
    expect(redactDetail(input)).toEqual({
      answer: '[redacted]',
      text: 'reach me at bo***, code [code]',
      nested: {
        pin: '[redacted]',
        list: [
          {
            otp: '[redacted]',
            Password: '[redacted]',
            clientSecret: '[redacted]',
            answer_hash: '[redacted]',
            token: '[redacted]',
            code: '[redacted]',
          },
          'code [code]',
        ],
      },
      count: 3,
      ok: true,
      none: null,
      at,
    });
    expect(input.answer).toBe('St. Louis');
    expect(input.nested.pin).toBe('123456');
  });

  it('passes primitives through', () => {
    expect(redactDetail(7)).toBe(7);
    expect(redactDetail(undefined)).toBeUndefined();
    expect(redactDetail('pin 123456')).toBe('pin [code]');
  });
});

describe('maskEmail and maskPhone', () => {
  it('keeps the first two characters of an email', () => {
    expect(maskEmail('jane.doe@contoso-health.example')).toBe('ja***');
  });

  it('keeps the last four digits of a phone', () => {
    expect(maskPhone('1234')).toBe('***-***-1234');
  });
});
