import { describe, expect, it } from 'vitest';
import { toSafeDatabaseId } from './safe-id';

describe('toSafeDatabaseId', () => {
  it('accepts safe numeric forms, including values beyond int4', () => {
    expect(toSafeDatabaseId(2_147_483_648, 'chat_events.id')).toBe(2_147_483_648);
    expect(toSafeDatabaseId('9007199254740991', 'tickets.id')).toBe(Number.MAX_SAFE_INTEGER);
    expect(toSafeDatabaseId(9_007_199_254_740_991n, 'audit_events.id')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    ['0', 'zero'],
    ['-1', 'negative'],
    ['1.5', 'fractional'],
    ['9007199254740992', 'unsafe positive'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'infinity'],
    ['', 'empty'],
    ['not-an-id', 'non-numeric'],
  ])('rejects %s (%s)', (value, label) => {
    expect(() => toSafeDatabaseId(value, label)).toThrow(RangeError);
  });
});
