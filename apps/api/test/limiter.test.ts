import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createRateLimiter } from '../src/limiter';

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-07T12:00:10Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

test('allows each key up to its limit within the minute', () => {
  const allow = createRateLimiter();
  expect([allow('ip:a', 2), allow('ip:a', 2), allow('ip:a', 2)]).toEqual([true, true, false]);
  expect(allow('ip:b', 2)).toBe(true);
  expect([allow('session:x', 1), allow('session:x', 1)]).toEqual([true, false]);
});

test('starts a fresh window at each minute boundary', () => {
  const allow = createRateLimiter();
  allow('ip:a', 1);
  vi.setSystemTime(new Date('2026-10-07T12:00:59.999Z'));
  expect(allow('ip:a', 1)).toBe(false);
  vi.setSystemTime(new Date('2026-10-07T12:01:00Z'));
  expect([allow('ip:a', 1), allow('ip:a', 1)]).toEqual([true, false]);
});
