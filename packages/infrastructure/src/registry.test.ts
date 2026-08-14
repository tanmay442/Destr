import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProviderRegistry } from './registry';

describe('createProviderRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the factory registered for a key', () => {
    const registry = createProviderRegistry<() => number>();
    const factory = () => 42;
    registry.register('a', factory);
    expect(registry.get('a')).toBe(factory);
  });

  it('returns undefined for an unknown key', () => {
    const registry = createProviderRegistry<() => number>();
    expect(registry.get('missing')).toBeUndefined();
  });

  it('warns and last-registration-wins when a key is re-registered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = createProviderRegistry<() => number>();
    const first = () => 1;
    const second = () => 2;
    registry.register('a', first);
    registry.register('a', second);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(registry.get('a')).toBe(second);
  });

  it('keeps per-instance state independent', () => {
    const a = createProviderRegistry<() => number>();
    const b = createProviderRegistry<() => number>();
    const factory = () => 7;
    a.register('x', factory);
    expect(a.get('x')).toBe(factory);
    expect(b.get('x')).toBeUndefined();
  });
});
