import { describe, expect, it } from 'vitest';
import {
  buildRetrievalCandidateCacheKey,
  createInMemoryRetrievalCandidateCache,
  createRedisRetrievalCandidateCache,
  type CachedCandidate,
  type RetrievalCandidateKeyInput,
} from '../retrieval-candidate-cache';
import { createCandidateCachePort } from '../candidate-cache-port-adapter';

function inputFixture(overrides: Partial<RetrievalCandidateKeyInput> = {}): RetrievalCandidateKeyInput {
  return {
    tenantId: 'deployment',
    corpusVersion: 'corpus-v1',
    indexVersion: 'index-1',
    normalizedQuery: 'how do refunds work?',
    modality: 'vector',
    filterHash: 'nofilter',
    retrievalConfigVersion: 'retrieval-v1',
    ...overrides,
  };
}

function candidateFixture(overrides: Partial<CachedCandidate> = {}): CachedCandidate {
  return {
    chunkUid: 'uid-7-2',
    documentId: 7,
    chunkIndex: 2,
    queryId: 'q-1',
    subquestionId: 'sq-1',
    scores: { dense: 0.91, finalRank: 1, finalSignal: 'dense' },
    ...overrides,
  };
}

describe('createCandidateCachePort', () => {
  it('builds the single-sourced storage key', () => {
    const port = createCandidateCachePort(createInMemoryRetrievalCandidateCache());
    const input = inputFixture();
    expect(port.buildKey(input)).toBe(buildRetrievalCandidateCacheKey(input));
  });

  it('round-trips candidates with score and query provenance', async () => {
    const port = createCandidateCachePort(createInMemoryRetrievalCandidateCache());
    const input = inputFixture();
    const key = port.buildKey(input);
    expect(await port.get(key, input)).toEqual({ outcome: 'miss' });
    const candidates = [candidateFixture(), candidateFixture({ chunkUid: 'uid-7-5', chunkIndex: 5 })];
    await port.set(key, input, candidates);
    expect(await port.get(key, input)).toEqual({ outcome: 'hit', candidates });
    expect(port.stats()).toMatchObject({ hits: 1, misses: 1, sets: 1 });
  });

  it('surfaces stale versions instead of serving them', async () => {
    const port = createCandidateCachePort(createInMemoryRetrievalCandidateCache());
    const input = inputFixture();
    const key = port.buildKey(input);
    await port.set(key, input, [candidateFixture()]);
    expect(await port.get(key, inputFixture({ corpusVersion: 'corpus-v2' }))).toEqual({
      outcome: 'stale_version',
    });
  });

  it('degrades Redis failures fail-open without throwing', async () => {
    const throwing = {
      get: async (): Promise<never> => {
        throw new Error('redis down');
      },
      set: async (): Promise<never> => {
        throw new Error('redis down');
      },
    };
    const port = createCandidateCachePort(createRedisRetrievalCandidateCache(throwing));
    const input = inputFixture();
    const key = port.buildKey(input);
    await expect(port.get(key, input)).resolves.toEqual({ outcome: 'error_degraded' });
    await expect(port.set(key, input, [candidateFixture()])).resolves.toBeUndefined();
    expect(port.stats().errors).toBe(2);
  });
});
