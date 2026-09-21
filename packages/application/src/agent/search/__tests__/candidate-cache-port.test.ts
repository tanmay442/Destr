import { describe, expect, it, vi } from 'vitest';
import type { RetrievedChunkRow } from '@app/domain';
import type { RetrievedChunk } from '../../../rag/search/search-types';
import {
  buildCandidateCacheContext,
  candidatesFromSearchResult,
  fetchCandidateRows,
  normalizeCandidateQuery,
  rehydrateCandidates,
  MAX_CACHED_CANDIDATES,
  type CandidateCacheEntry,
  type CandidateCacheKeyInput,
  type CandidateCacheLookup,
  type CandidateCachePort,
  type CandidateChunkSource,
} from '../candidate-cache-port';

function row(overrides: Partial<RetrievedChunkRow> & { id: number; documentId: number }): RetrievedChunkRow {
  return {
    fileName: 'guide.md',
    page: 1,
    sectionTitle: 'Setup',
    source: 'docs/guide.md',
    title: 'Guide',
    content: `Content for chunk ${overrides.id}.`,
    similarity: 0.9,
    parentChunkId: null,
    chunkIndex: 0,
    chunkUid: `uid-${overrides.documentId}-${overrides.chunkIndex ?? 0}`,
    documentUid: `doc-${overrides.documentId}`,
    ...overrides,
  } as RetrievedChunkRow;
}

function chunk(overrides: Partial<RetrievedChunk> & { id: number; documentId: number }): RetrievedChunk {
  return {
    fileName: 'guide.md',
    page: 1,
    sectionTitle: 'Setup',
    source: 'docs/guide.md',
    title: 'Guide',
    content: `Content for chunk ${overrides.id}.`,
    chunkIndex: 0,
    chunkUid: `uid-${overrides.documentId}-${overrides.chunkIndex ?? 0}`,
    scores: { dense: 0.9, finalRank: 1, finalSignal: 'dense' },
    ...overrides,
  } as RetrievedChunk;
}

function contextBase() {
  return {
    tenantId: 'deployment',
    corpusVersion: 'corpus-v1',
    indexVersion: 'gemini-embedding-001:d1536',
    query: 'How do refunds work?',
    modality: 'vector' as const,
    retrievalConfigVersion: 'retrieval-v1',
  };
}

function fakePort(): CandidateCachePort & { readonly entries: Map<string, CandidateCacheEntry[]> } {
  const entries = new Map<string, CandidateCacheEntry[]>();
  let hits = 0;
  let misses = 0;
  let sets = 0;
  return {
    entries,
    buildKey: (input: CandidateCacheKeyInput) =>
      `fake:${input.tenantId}:${input.corpusVersion}:${input.indexVersion}:${input.modality}:${input.filterHash}:${input.retrievalConfigVersion}:${input.normalizedQuery}`,
    get: async (key: string) => {
      const found = entries.get(key);
      if (found === undefined) {
        misses += 1;
        return { outcome: 'miss' } satisfies CandidateCacheLookup;
      }
      hits += 1;
      return { outcome: 'hit', candidates: found } satisfies CandidateCacheLookup;
    },
    set: async (key: string, _input: unknown, candidates: readonly CandidateCacheEntry[]) => {
      sets += 1;
      entries.set(key, [...candidates]);
    },
    stats: () => ({ hits, misses, sets, staleVersions: 0, errors: 0 }),
  } as unknown as CandidateCachePort & { readonly entries: Map<string, CandidateCacheEntry[]> };
}

describe('normalizeCandidateQuery', () => {
  it('trims, lowercases, and collapses whitespace', () => {
    expect(normalizeCandidateQuery('  How  do REFUNDS  work ? ')).toBe('how do refunds work?');
  });
});

describe('buildCandidateCacheContext', () => {
  it('builds a key input with normalized query and filter hashing', () => {
    expect(buildCandidateCacheContext(contextBase())).toMatchObject({
      tenantId: 'deployment',
      normalizedQuery: 'how do refunds work?',
      modality: 'vector',
      filterHash: 'nofilter',
    });
    expect(
      buildCandidateCacheContext({ ...contextBase(), filter: { documentId: 9 } }).filterHash,
    ).toBe('doc:9');
  });

  it('fails fast on empty queries and invalid filters', () => {
    expect(() => buildCandidateCacheContext({ ...contextBase(), query: '   ' })).toThrow();
    expect(() => buildCandidateCacheContext({ ...contextBase(), filter: { documentId: -1 } })).toThrow();
  });
});

describe('candidatesFromSearchResult', () => {
  it('strips ids and scores only, never text', () => {
    const chunks = [chunk({ id: 1, documentId: 7, chunkIndex: 2 }), chunk({ id: 2, documentId: 7, chunkIndex: 5 })];
    const entries = candidatesFromSearchResult(chunks, { queryId: 'q-1', subquestionId: 'sq-1' });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      documentId: 7,
      chunkIndex: 2,
      chunkUid: 'uid-7-2',
      queryId: 'q-1',
      subquestionId: 'sq-1',
      scores: { dense: 0.9, finalRank: 1, finalSignal: 'dense' },
    });
    for (const entry of entries) {
      expect(entry).not.toHaveProperty('content');
      expect(entry).not.toHaveProperty('similarity');
    }
    expect(JSON.stringify(entries)).not.toContain('Content for chunk');
  });

  it('truncates oversized result sets to the store limit and rejects empty provenance', () => {
    const chunks = Array.from({ length: MAX_CACHED_CANDIDATES + 1 }, (_, index) =>
      chunk({ id: index + 1, documentId: 1, chunkIndex: index }),
    );
    expect(candidatesFromSearchResult(chunks, { queryId: 'q', subquestionId: 's' })).toHaveLength(
      MAX_CACHED_CANDIDATES,
    );
    expect(() => candidatesFromSearchResult(chunks, { queryId: '', subquestionId: 's' })).toThrow();
  });
});

describe('rehydrateCandidates', () => {
  it('rebuilds full chunks from cached scores plus fetched rows', () => {
    const chunks = [chunk({ id: 11, documentId: 7, chunkIndex: 2 }), chunk({ id: 22, documentId: 7, chunkIndex: 5 })];
    const entries = candidatesFromSearchResult(chunks, { queryId: 'q-1', subquestionId: 'sq-1' });
    const rows = [row({ id: 11, documentId: 7, chunkIndex: 2 }), row({ id: 22, documentId: 7, chunkIndex: 5 })];
    const rehydrated = rehydrateCandidates(entries, rows);
    expect(rehydrated?.map((item) => item.content)).toEqual([
      'Content for chunk 11.',
      'Content for chunk 22.',
    ]);
    expect(rehydrated?.map((item) => item.scores)).toEqual(chunks.map((item) => item.scores));
  });

  it('is all-or-nothing: any missing id is a miss', () => {
    const entries = candidatesFromSearchResult(
      [chunk({ id: 11, documentId: 7, chunkIndex: 2 }), chunk({ id: 99, documentId: 8, chunkIndex: 0 })],
      { queryId: 'q-1', subquestionId: 'sq-1' },
    );
    expect(rehydrateCandidates(entries, [row({ id: 11, documentId: 7, chunkIndex: 2 })])).toBeNull();
  });

  it('prefers chunkUid on ties and rejects scores missing their final signal', () => {
    const entries = candidatesFromSearchResult([chunk({ id: 11, documentId: 7, chunkIndex: 2 })], {
      queryId: 'q-1',
      subquestionId: 'sq-1',
    });
    const rows = [
      row({ id: 100, documentId: 7, chunkIndex: 2, chunkUid: 'other-uid', content: 'Wrong row.' }),
      row({ id: 11, documentId: 7, chunkIndex: 2, content: 'Right row.' }),
    ];
    expect(rehydrateCandidates(entries, rows)?.[0]?.content).toBe('Right row.');
    const broken: CandidateCacheEntry[] = [
      { ...entries[0] as CandidateCacheEntry, scores: { finalRank: 1, finalSignal: 'dense' } },
    ];
    expect(rehydrateCandidates(broken, rows)).toBeNull();
  });

  it('treats a replacement UID at the cached coordinates as a miss', () => {
    const entries = candidatesFromSearchResult([
      chunk({ id: 11, documentId: 7, chunkIndex: 2, chunkUid: 'old-uid' }),
    ], {
      queryId: 'q-1',
      subquestionId: 'sq-1',
    });
    const replacement = row({
      id: 22,
      documentId: 7,
      chunkIndex: 2,
      chunkUid: 'new-uid',
      content: 'Replacement content.',
    });
    expect(rehydrateCandidates(entries, [replacement])).toBeNull();
  });
});

describe('fetchCandidateRows', () => {
  it('fetches one range per document and flattens every bucket', async () => {
    const entries = candidatesFromSearchResult(
      [
        chunk({ id: 1, documentId: 7, chunkIndex: 2 }),
        chunk({ id: 2, documentId: 7, chunkIndex: 5 }),
        chunk({ id: 3, documentId: 9, chunkIndex: 0 }),
      ],
      { queryId: 'q-1', subquestionId: 'sq-1' },
    );
    const source: CandidateChunkSource = {
      getByDocAndRanges: vi.fn().mockResolvedValue(
        new Map([
          ['7:2:5', [row({ id: 1, documentId: 7, chunkIndex: 2 })]],
          ['9:0:0', [row({ id: 3, documentId: 9, chunkIndex: 0 })]],
        ]),
      ),
    };
    const rows = await fetchCandidateRows(entries, source);
    expect(source.getByDocAndRanges).toHaveBeenCalledWith(
      [
        { documentId: 7, start: 2, end: 5 },
        { documentId: 9, start: 0, end: 0 },
      ],
      {},
    );
    expect(rows.map((item) => item.id).sort()).toEqual([1, 3]);
  });

  it('short-circuits empty candidate sets without touching the source', async () => {
    const source: CandidateChunkSource = { getByDocAndRanges: vi.fn() };
    expect(await fetchCandidateRows([], source)).toEqual([]);
    expect(source.getByDocAndRanges).not.toHaveBeenCalled();
  });
});

describe('candidate cache round trip (fake port + fake source)', () => {
  it('stores stripped candidates and rehydrates them back to full chunks', async () => {
    const port = fakePort();
    const chunks = [chunk({ id: 11, documentId: 7, chunkIndex: 2 }), chunk({ id: 22, documentId: 7, chunkIndex: 5 })];
    const keyInput = buildCandidateCacheContext(contextBase());
    const key = 'rc:test-key';
    await port.set(key, keyInput, candidatesFromSearchResult(chunks, { queryId: 'q-1', subquestionId: 'sq-1' }));
    const lookup = await port.get(key, keyInput);
    expect(lookup.outcome).toBe('hit');
    if (lookup.outcome !== 'hit') throw new Error('expected a cache hit');
    const source: CandidateChunkSource = {
      getByDocAndRanges: async () =>
        new Map([['7:2:5', [row({ id: 11, documentId: 7, chunkIndex: 2 }), row({ id: 22, documentId: 7, chunkIndex: 5 })]]]),
    };
    const rehydrated = rehydrateCandidates(lookup.candidates, await fetchCandidateRows(lookup.candidates, source));
    expect(rehydrated?.map((item) => item.id)).toEqual([11, 22]);
    expect(rehydrated?.map((item) => item.content)).toEqual([
      'Content for chunk 11.',
      'Content for chunk 22.',
    ]);
  });
});
