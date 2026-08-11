import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTtlCache, primaryEmailAddress } from './clerk-shared';

afterEach(() => {
  vi.useRealTimers();
});

describe('primaryEmailAddress', () => {
  it('prefers the email matching primaryEmailAddressId', () => {
    const email = primaryEmailAddress(
      [
        { id: 'email_b', emailAddress: 'secondary@example.com' },
        { id: 'email_a', emailAddress: 'primary@example.com' },
      ],
      'email_a',
    );
    expect(email).toBe('primary@example.com');
  });

  it('falls back to the first address when no primary matches', () => {
    const email = primaryEmailAddress(
      [
        { id: 'email_b', emailAddress: 'secondary@example.com' },
        { id: 'email_a', emailAddress: 'primary@example.com' },
      ],
      'missing',
    );
    expect(email).toBe('secondary@example.com');
  });

  it('returns an empty string when there are no addresses', () => {
    expect(primaryEmailAddress(undefined, null)).toBe('');
    expect(primaryEmailAddress([], 'email_a')).toBe('');
  });
});

describe('createTtlCache', () => {
  it('returns the stored value within the TTL', () => {
    const cache = createTtlCache<string>(1000, 10);
    cache.set('a', '1');
    expect(cache.get('a')).toBe('1');
  });

  it('evicts expired entries lazily on access', () => {
    vi.useFakeTimers();
    const cache = createTtlCache<string>(1000, 10);
    cache.set('a', '1');
    vi.advanceTimersByTime(1_001);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('caps the number of entries and evicts the oldest when full', () => {
    const cache = createTtlCache<string>(60_000, 2);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    expect(cache.size()).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
    expect(cache.get('c')).toBe('3');
  });

  it('removes an entry immediately', () => {
    const cache = createTtlCache<string>(60_000, 10);
    cache.set('a', '1');
    cache.remove('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('remove is a no-op for a missing key', () => {
    const cache = createTtlCache<string>(60_000, 10);
    cache.set('a', '1');
    cache.remove('missing');
    expect(cache.get('a')).toBe('1');
    expect(cache.size()).toBe(1);
  });
});