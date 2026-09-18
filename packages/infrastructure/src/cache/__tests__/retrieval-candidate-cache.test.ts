import { describe, expect, it } from 'vitest';
import {
  RETRIEVAL_CANDIDATE_CACHE_VERSION,
  buildRetrievalCandidateCacheKey,
  createInMemoryRetrievalCandidateCache,
  createRedisRetrievalCandidateCache,
  type CachedCandidate,
  type RetrievalCandidateKeyInput,
  type RetrievalCandidateRedisClient,
} from '../retrieval-candidate-cache';

function inputFixture(overrides: Partial<RetrievalCandidateKeyInput> = {}): RetrievalCandidateKeyInput {
  return {
    tenantId: 'tenant-a',
    corpusVersion: 'corpus-7',
    indexVersion: 'index-3',
    normalizedQuery: 'refund policy deadline',
    modality: 'vector',
    filterHash: 'nofilter',
    retrievalConfigVersion: 'retrieval-v2',
    ...overrides,
  };
}

function candidateFixture(overrides: Partial<CachedCandidate> = {}): CachedCandidate {
  return {
    chunkUid: 'chunk-uid-1',
    documentId: 7,
    chunkIndex: 2,
    queryId: 'q-1',
    subquestionId: 'sq-1',
    scores: { dense: 0.91, finalRank: 1, finalSignal: 'dense' },
    ...overrides,
  };
}

function fakeRedisClient(): RetrievalCandidateRedisClient & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (key: string) => entries.get(key) ?? null,
    set: async (key: string, value: string) => {
      entries.set(key, value);
      return 'OK';
    },
  };
}

describe('buildRetrievalCandidateCacheKey', () => {
  it('is deterministic, versioned, and scoped by corpus, index, modality, filter, and config', () => {
    const key = buildRetrievalCandidateCacheKey(inputFixture());
    expect(key).toContain(RETRIEVAL_CANDIDATE_CACHE_VERSION);
    expect(buildRetrievalCandidateCacheKey(inputFixture())).toBe(key);
    expect(buildRetrievalCandidateCacheKey(inputFixture({ tenantId: 'tenant-b' }))).not.toBe(key);
    expect(buildRetrievalCandidateCacheKey(inputFixture({ corpusVersion: 'corpus-8' }))).not.toBe(key);
    expect(buildRetrievalCandidateCacheKey(inputFixture({ indexVersion: 'index-4' }))).not.toBe(key);
    expect(buildRetrievalCandidateCacheKey(inputFixture({ modality: 'lexical' }))).not.toBe(key);
    expect(buildRetrievalCandidateCacheKey(inputFixture({ filterHash: 'doc-9' }))).not.toBe(key);
    expect(
      buildRetrievalCandidateCacheKey(inputFixture({ retrievalConfigVersion: 'retrieval-v3' })),
    ).not.toBe(key);
  });
});

describe('in-memory retrieval-candidate cache', () => {
  it('retains score and query provenance across a round trip', async () => {
    const cache = createInMemoryRetrievalCandidateCache();
    const input = inputFixture();
    const key = buildRetrievalCandidateCacheKey(input);
    const candidates = [
      candidateFixture(),
      candidateFixture({
        chunkUid: 'chunk-uid-2',
        documentId: 7,
        chunkIndex: 5,
        queryId: 'q-2',
        scores: { lexical: 12.5, fusion: 0.02, finalRank: 2, finalSignal: 'fusion' },
      }),
    ];
    expect(await cache.get(key, input)).toEqual({ outcome: 'miss' });
    await cache.set(key, input, candidates);
    const lookup = await cache.get(key, input);
    expect(lookup).toEqual({ outcome: 'hit', candidates });
    if (lookup.outcome === 'hit') {
      expect(lookup.candidates[0]?.queryId).toBe('q-1');
      expect(lookup.candidates[0]?.subquestionId).toBe('sq-1');
      expect(lookup.candidates[1]?.scores.finalSignal).toBe('fusion');
    } else {
      throw new Error('expected a cache hit');
    }
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, sets: 1 });
  });

  it('rejects stale corpus, index, config, and tenant versions', async () => {
    const cache = createInMemoryRetrievalCandidateCache();
    const input = inputFixture();
    const key = buildRetrievalCandidateCacheKey(input);
    const variants = [
      inputFixture({ corpusVersion: 'corpus-8' }),
      inputFixture({ indexVersion: 'index-4' }),
      inputFixture({ retrievalConfigVersion: 'retrieval-v3' }),
      inputFixture({ tenantId: 'tenant-b' }),
      inputFixture({ modality: 'lexical' }),
    ];
    for (const variant of variants) {
      await cache.set(key, input, [candidateFixture()]);
      expect(await cache.get(key, variant)).toEqual({ outcome: 'stale_version' });
    }
    expect(cache.stats().staleVersions).toBe(5);
  });

  it('expires entries after the TTL', async () => {
    const cache = createInMemoryRetrievalCandidateCache({ ttlMs: 10 });
    const input = inputFixture();
    const key = buildRetrievalCandidateCacheKey(input);
    await cache.set(key, input, [candidateFixture()]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await cache.get(key, input)).toEqual({ outcome: 'miss' });
  });

  it('rejects malformed candidate sets without throwing', async () => {
    const cache = createInMemoryRetrievalCandidateCache();
    const input = inputFixture();
    const key = buildRetrievalCandidateCacheKey(input);
    await cache.set(key, input, [{ documentId: 1, chunkIndex: 0 } as unknown as CachedCandidate]);
    expect(await cache.get(key, input)).toEqual({ outcome: 'miss' });
    expect(cache.stats().errors).toBe(1);
  });
});

describe('redis retrieval-candidate cache', () => {
  it('round-trips candidates with provenance through a Redis-compatible client', async () => {
    const cache = createRedisRetrievalCandidateCache(fakeRedisClient());
    const input = inputFixture();
    const key = buildRetrievalCandidateCacheKey(input);
    await cache.set(key, input, [candidateFixture()]);
    const lookup = await cache.get(key, input);
    expect(lookup.outcome).toBe('hit');
    if (lookup.outcome === 'hit') {
      expect(lookup.candidates).toHaveLength(1);
      expect(lookup.candidates[0]?.subquestionId).toBe('sq-1');
    }
  });

  it('degrades to counted misses instead of throwing when Redis fails', async () => {
    const failing: RetrievalCandidateRedisClient = {
      get: async () => {
        throw new Error('redis down');
      },
      set: async () => {
        throw new Error('redis down');
      },
    };
    const cache = createRedisRetrievalCandidateCache(failing);
    const input = inputFixture();
    expect(await cache.get('any-key', input)).toEqual({ outcome: 'error_degraded' });
    await cache.set('any-key', input, [candidateFixture()]);
    expect(cache.stats().errors).toBe(2);
  });
});
