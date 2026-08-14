import { describe, it, expect } from 'vitest';
import { resolveTurnId, isV4Uuid } from '../turn-id';

describe('resolveTurnId', () => {
  it('accepts a valid v4-shaped uuid', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(resolveTurnId(id)).toBe(id);
  });

  it('rejects non-v4 uuid versions', () => {
    expect(resolveTurnId('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBeNull();
    expect(resolveTurnId('3f2504e0-4f89-21d3-9a0c-0305e82c3301')).toBeNull();
    expect(resolveTurnId('3f2504e0-4f89-31d3-9a0c-0305e82c3301')).toBeNull();
    expect(resolveTurnId('3f2504e0-4f89-51d3-9a0c-0305e82c3301')).toBeNull();
  });

  it('rejects an all-zero uuid', () => {
    expect(resolveTurnId('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('ignores a malformed uuid string', () => {
    expect(resolveTurnId('not-a-uuid')).toBeNull();
    expect(resolveTurnId('3f2504e0-4f89-41d3-9a0c')).toBeNull();
  });

  it('ignores non-string input', () => {
    expect(resolveTurnId(undefined)).toBeNull();
    expect(resolveTurnId(1234)).toBeNull();
    expect(resolveTurnId(null)).toBeNull();
  });
});

describe('isV4Uuid', () => {
  it('narrows only v4 uuids', () => {
    expect(isV4Uuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    expect(isV4Uuid('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(false);
    expect(isV4Uuid(42)).toBe(false);
  });
});
