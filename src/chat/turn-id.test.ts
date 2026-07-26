import { describe, it, expect } from 'vitest';
import { resolveTurnId } from './turn-id';

describe('resolveTurnId', () => {
  it('accepts a valid v4-shaped uuid', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(resolveTurnId(id)).toBe(id);
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
