import { describe, it, expect } from 'vitest';
import { parseQueryPagination, parsePageParam } from '@/composition';
import { MAX_LIST_LIMIT } from '@app/domain';

describe('parseQueryPagination', () => {
  it('falls back to defaults when given NaN values', () => {
    const url = new URL('http://localhost/api/test?limit=abc&offset=xyz');
    const { limit, offset } = parseQueryPagination(url);
    expect(limit).toBe(25);
    expect(offset).toBe(0);
  });

  it('uses provided defaults', () => {
    const url = new URL('http://localhost/api/test');
    const { limit, offset } = parseQueryPagination(url, { limit: 50, offset: 10 });
    expect(limit).toBe(50);
    expect(offset).toBe(10);
  });

  it('parses valid query params', () => {
    const url = new URL('http://localhost/api/test?limit=10&offset=5');
    const { limit, offset } = parseQueryPagination(url);
    expect(limit).toBe(10);
    expect(offset).toBe(5);
  });

  it('clamps limit to MAX_LIST_LIMIT', () => {
    const url = new URL(`http://localhost/api/test?limit=${MAX_LIST_LIMIT + 1000}`);
    const { limit } = parseQueryPagination(url);
    expect(limit).toBe(MAX_LIST_LIMIT);
  });

  it('enforces minimum limit of 1', () => {
    const url = new URL('http://localhost/api/test?limit=0');
    const { limit } = parseQueryPagination(url);
    expect(limit).toBe(1);
  });

  it('enforces minimum offset of 0', () => {
    const url = new URL('http://localhost/api/test?offset=-5');
    const { offset } = parseQueryPagination(url);
    expect(offset).toBe(0);
  });

  it('floors float values', () => {
    const url = new URL('http://localhost/api/test?limit=2.9&offset=3.7');
    const { limit, offset } = parseQueryPagination(url);
    expect(limit).toBe(2);
    expect(offset).toBe(3);
  });

  it('handles negative limit by flooring then clamping to 1', () => {
    const url = new URL('http://localhost/api/test?limit=-10');
    const { limit } = parseQueryPagination(url);
    expect(limit).toBe(1);
  });

  it('handles empty string limit (Number("") is 0, clamps to 1)', () => {
    const url = new URL('http://localhost/api/test?limit=');
    const { limit } = parseQueryPagination(url);
    expect(limit).toBe(1);
  });

  it('handles Infinity limit by falling back to default', () => {
    const url = new URL('http://localhost/api/test?limit=Infinity');
    const { limit } = parseQueryPagination(url);
    expect(limit).toBe(25);
  });

  it('handles very large offset by clamping to 0 if negative', () => {
    const url = new URL('http://localhost/api/test?offset=-999');
    const { offset } = parseQueryPagination(url);
    expect(offset).toBe(0);
  });

  it('accepts offset of exactly 0', () => {
    const url = new URL('http://localhost/api/test?offset=0');
    const { offset } = parseQueryPagination(url);
    expect(offset).toBe(0);
  });
});

describe('parsePageParam', () => {
  it('returns fallback for undefined', () => {
    expect(parsePageParam(undefined)).toBe(1);
  });

  it('returns fallback for NaN strings', () => {
    expect(parsePageParam('abc')).toBe(1);
  });

  it('returns fallback for negative numbers', () => {
    expect(parsePageParam('-3')).toBe(1);
  });

  it('returns fallback for zero', () => {
    expect(parsePageParam('0')).toBe(1);
  });

  it('floors float values', () => {
    expect(parsePageParam('2.9')).toBe(2);
  });

  it('parses valid integers', () => {
    expect(parsePageParam('5')).toBe(5);
  });

  it('uses custom fallback', () => {
    expect(parsePageParam(undefined, 3)).toBe(3);
    expect(parsePageParam('abc', 3)).toBe(3);
  });
});
