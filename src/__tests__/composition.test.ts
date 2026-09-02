import { describe, it, expect } from 'vitest';
import {
  parseQueryPagination,
  parsePageParam,
  getComposition,
  availableRerankers,
  resolveReranker,
  assertSameOrigin,
} from '@/composition';
import { MAX_LEGACY_LIST_OFFSET, MAX_LIST_LIMIT } from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';

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

  it('caps legacy offsets to the bounded compatibility window', () => {
    const url = new URL(`http://localhost/api/test?offset=${MAX_LEGACY_LIST_OFFSET + 1}`);
    const { offset } = parseQueryPagination(url);
    expect(offset).toBe(MAX_LEGACY_LIST_OFFSET);
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

describe('getComposition wiring', () => {
  it('returns a singleton instance', () => {
    expect(getComposition()).toBe(getComposition());
  });

  it('exposes the expected API surface', () => {
    const comp = getComposition();
    expect(typeof comp.ingestFile).toBe('function');
    expect(typeof comp.searchChunks).toBe('function');
    expect(typeof comp.agenticSearch).toBe('function');
    expect(typeof comp.uploadPdf).toBe('function');
    expect(typeof comp.replacePdf).toBe('function');
    expect(typeof comp.ingestQueuedDocument).toBe('function');
    expect(typeof comp.listUsers).toBe('function');
    expect(typeof comp.setUserRole).toBe('function');
    expect(typeof comp.listDocuments).toBe('function');
    expect(typeof comp.reingestAll).toBe('function');
    expect(comp.db).toBeDefined();
    expect(comp.schema).toBeDefined();
    expect(comp.answerCache).toBeDefined();
    expect(comp.settingsRepo).toBeDefined();
  });
});

describe('reranker selection', () => {
  it('availableRerankers reports a status for every registry key', () => {
    const rerankers = availableRerankers();
    expect(rerankers.has('cosine')).toBe(true);
    expect(rerankers.has('cohere')).toBe(true);
    expect(rerankers.has('local')).toBe(true);
    for (const status of rerankers.values()) {
      expect(typeof status.ok).toBe('boolean');
    }
  });

  it('resolveReranker returns undefined for cosine (default path)', () => {
    expect(resolveReranker({ rerankerProvider: 'cosine' } as AppConfig)).toBeUndefined();
  });

  it('resolveReranker returns undefined for cohere when no API key is configured', () => {
    expect(resolveReranker({ rerankerProvider: 'cohere' } as AppConfig)).toBeUndefined();
  });
});

describe('assertSameOrigin', () => {
  it('passes when no origin header is present', () => {
    const req = new Request('http://localhost:3000/api/x', {
      headers: { host: 'localhost:3000' },
    });
    expect(assertSameOrigin(req)).toBeNull();
  });

  it('passes for a same-origin request', () => {
    const req = new Request('http://localhost:3000/api/x', {
      headers: {
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(assertSameOrigin(req)).toBeNull();
  });

  it('rejects a cross-origin request with 403', () => {
    const req = new Request('http://localhost:3000/api/x', {
      headers: { origin: 'http://evil.com', host: 'localhost:3000' },
    });
    const res = assertSameOrigin(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});
