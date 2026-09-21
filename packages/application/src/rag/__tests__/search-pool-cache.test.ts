import { describe, expect, it, vi } from 'vitest';
import { searchChunks } from '../search';
import type { SearchDeps } from '../search';
import type { RetrievedChunkRow } from '@app/domain';
import type {
  CandidateCacheEntry,
  CandidateCacheKeyInput,
  CandidateCachePort,
} from '../../agent/search/candidate-cache-port';

function row(id: number, documentId: number, chunkIndex: number, content: string): RetrievedChunkRow {
  return {
    id,
    documentId,
    chunkUid: `uid-${documentId}-${chunkIndex}`,
    fileName: 'guide.md',
    page: 1,
    sectionTitle: null,
    source: 'docs/guide.md',
    title: 'Guide',
    content,
    similarity: 0.9 - id * 0.01,
    parentChunkId: null,
    chunkIndex,
  };
}

function fakePort(): CandidateCachePort & { calls: { get: number; set: number } } {
  const entries = new Map<string, CandidateCacheEntry[]>();
  const calls = { get: 0, set: 0 };
  return {
    calls,
    buildKey: (input: CandidateCacheKeyInput) => JSON.stringify(input),
    get: async (key: string) => {
      calls.get += 1;
      const found = entries.get(key);
      return found === undefined ? { outcome: 'miss' } : { outcome: 'hit', candidates: found };
    },
    set: async (key: string, _input: CandidateCacheKeyInput, candidates: readonly CandidateCacheEntry[]) => {
      calls.set += 1;
      entries.set(key, [...candidates]);
    },
    stats: () => ({ hits: 0, misses: 0, sets: 0, staleVersions: 0, errors: 0 }),
  };
}

const VERSIONS = {
  tenantId: 'test-tenant',
  corpusVersion: 'corpus-v1',
  indexVersion: 'idx-v1',
  retrievalConfigVersion: 'retrieval-v1',
};

function makeDeps(
  vectorRows: RetrievedChunkRow[],
  port: CandidateCachePort,
  overrides?: Partial<SearchDeps>,
): { deps: SearchDeps; searchByVector: ReturnType<typeof vi.fn>; searchByLexical: ReturnType<typeof vi.fn> } {
  const searchByVector = vi.fn(async () => [...vectorRows]);
  const searchByLexical = vi.fn(async () => [] as RetrievedChunkRow[]);
  const rowsByDoc = () => {
    const live = new Map<string, RetrievedChunkRow[]>();
    for (const r of vectorRows) {
      const key = `${r.documentId}:${r.chunkIndex}:${r.chunkIndex}`;
      const bucket = live.get(key) ?? [];
      bucket.push(r);
      live.set(key, bucket);
    }
    return live;
  };
  const deps: SearchDeps = {
    chunks: {
      insertMany: vi.fn(),
      deleteByDocumentId: vi.fn(),
      searchByVector,
      searchByLexical,
      getByIds: vi.fn(async (ids: number[]) => vectorRows.filter((r) => ids.includes(r.id))),
      getByDocAndRange: vi.fn(async () => []),
      getByDocAndRanges: vi.fn(async () => rowsByDoc()),
      countForDocuments: vi.fn(),
      countForAll: vi.fn(),
      countForDocument: vi.fn(),
      recountAll: vi.fn(),
    } as unknown as SearchDeps['chunks'],
    embeddings: {
      embed: vi.fn(async () => [0.1, 0.2, 0.3]),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    },
    candidateCache: port,
    candidateCacheVersions: VERSIONS,
    ...overrides,
  };
  return { deps, searchByVector, searchByLexical };
}

describe('searchChunks candidate pools (WP-9 F-34 wiring)', () => {
  it('serves the second identical query from cache without SQL', async () => {
    const port = fakePort();
    const { deps, searchByVector, searchByLexical } = makeDeps(
      [row(1, 10, 0, 'First evidence.'), row(2, 10, 1, 'Second evidence.')],
      port,
    );
    const first = await searchChunks('refund policy', { limit: 5 }, deps);
    expect(first.ok).toBe(true);
    const second = await searchChunks('refund policy', { limit: 5 }, deps);
    expect(second.ok).toBe(true);
    expect(searchByVector).toHaveBeenCalledTimes(1);
    expect(searchByLexical).toHaveBeenCalledTimes(1);
    expect(port.calls.set).toBeGreaterThanOrEqual(2);
    if (first.ok && second.ok) {
      expect(second.value.chunks.map((c) => c.content)).toEqual(
        first.value.chunks.map((c) => c.content),
      );
    }
  });

  it('re-applies turn-local exclusions on a cache hit', async () => {
    const port = fakePort();
    const { deps, searchByVector } = makeDeps(
      [row(1, 10, 0, 'First evidence.'), row(2, 10, 1, 'Second evidence.')],
      port,
    );
    const first = await searchChunks('refund policy', { limit: 5 }, deps);
    expect(first.ok).toBe(true);
    const second = await searchChunks(
      'refund policy',
      { limit: 5, excludeChunkIdentities: new Set(['chunk_uid:uid-10-0', 'document_chunk:10:0']) },
      deps,
    );
    expect(second.ok).toBe(true);
    // Pool served from cache (no second SQL fetch) but the excluded chunk is gone.
    expect(searchByVector).toHaveBeenCalledTimes(1);
    if (second.ok) {
      expect(second.value.chunks.map((c) => c.content)).not.toContain('First evidence.');
      expect(second.value.chunks.map((c) => c.content)).toContain('Second evidence.');
    }
  });

  it('falls back to uncached retrieval on stale or degraded lookups', async () => {
    let outcome: 'stale_version' | 'error_degraded' = 'stale_version';
    const port = fakePort();
    const stalePort: CandidateCachePort = {
      ...port,
      get: async () => ({ outcome }),
    };
    const { deps, searchByVector } = makeDeps([row(1, 10, 0, 'Only evidence.')], stalePort);
    const first = await searchChunks('refund policy', { limit: 5 }, deps);
    expect(first.ok).toBe(true);
    outcome = 'error_degraded';
    const second = await searchChunks('refund policy', { limit: 5 }, deps);
    expect(second.ok).toBe(true);
    expect(searchByVector).toHaveBeenCalledTimes(2);
  });

  it('falls back to uncached retrieval when a cached chunk was deleted', async () => {
    const port = fakePort();
    const live = [row(1, 10, 0, 'First evidence.'), row(2, 10, 1, 'Second evidence.')];
    const { deps, searchByVector } = makeDeps(live, port);
    const first = await searchChunks('refund policy', { limit: 5 }, deps);
    expect(first.ok).toBe(true);
    // Simulate deletion: rehydration source no longer has chunk 2.
    live.pop();
    const second = await searchChunks('refund policy', { limit: 5 }, deps);
    expect(second.ok).toBe(true);
    expect(searchByVector).toHaveBeenCalledTimes(2);
    if (second.ok) {
      expect(second.value.chunks.map((c) => c.content)).toEqual(['First evidence.']);
    }
  });

  it('keys pools by candidate limit and threshold', async () => {
    const port = fakePort();
    const { deps, searchByVector } = makeDeps([row(1, 10, 0, 'Only evidence.')], port);
    await searchChunks('refund policy', { limit: 5, candidateLimit: 10 }, deps);
    await searchChunks('refund policy', { limit: 5, candidateLimit: 20 }, deps);
    expect(searchByVector).toHaveBeenCalledTimes(2);
    await searchChunks('refund policy', { limit: 5, candidateLimit: 10 }, deps);
    expect(searchByVector).toHaveBeenCalledTimes(2);
  });

  it('skips the cache entirely when no port is configured', async () => {
    const { deps, searchByVector } = makeDeps([row(1, 10, 0, 'Only evidence.')], fakePort());
    const { candidateCache: _dropped, candidateCacheVersions: _droppedVersions, ...rest } = deps as SearchDeps & {
      candidateCache?: unknown;
      candidateCacheVersions?: unknown;
    };
    void _dropped;
    void _droppedVersions;
    const uncached = { ...rest };
    await searchChunks('refund policy', { limit: 5 }, uncached);
    await searchChunks('refund policy', { limit: 5 }, uncached);
    expect(searchByVector).toHaveBeenCalledTimes(2);
  });
});
