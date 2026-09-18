import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_CACHE_VERSION,
  buildEmbeddingCacheKey,
  createInMemoryEmbeddingCache,
  createRedisEmbeddingCache,
  type EmbeddingCacheRedisClient,
  type EmbeddingKeyInput,
} from '../embedding-cache';

function inputFixture(overrides: Partial<EmbeddingKeyInput> = {}): EmbeddingKeyInput {
  return {
    tenantId: 'tenant-a',
    normalizedQuery: 'how do refunds work',
    embeddingModelId: 'embed-model',
    embeddingModelVersion: 'v3',
    dimensions: 3,
    ...overrides,
  };
}

function failingClient(): EmbeddingCacheRedisClient {
  return {
    get: async () => {
      throw new Error('redis down');
    },
    set: async () => {
      throw new Error('redis down');
    },
  };
}

function fakeRedisClient(): EmbeddingCacheRedisClient & { readonly entries: Map<string, string> } {
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

describe('buildEmbeddingCacheKey', () => {
  it('is deterministic, versioned, and tenant/model scoped', () => {
    const key = buildEmbeddingCacheKey(inputFixture());
    expect(key).toContain(EMBEDDING_CACHE_VERSION);
    expect(buildEmbeddingCacheKey(inputFixture())).toBe(key);
    expect(buildEmbeddingCacheKey(inputFixture({ tenantId: 'tenant-b' }))).not.toBe(key);
    expect(buildEmbeddingCacheKey(inputFixture({ embeddingModelVersion: 'v4' }))).not.toBe(key);
    expect(buildEmbeddingCacheKey(inputFixture({ dimensions: 4 }))).not.toBe(key);
    expect(buildEmbeddingCacheKey(inputFixture({ normalizedQuery: 'different query' }))).not.toBe(key);
  });
});

describe('in-memory embedding cache', () => {
  it('hits after set and misses when empty', async () => {
    const cache = createInMemoryEmbeddingCache();
    const input = inputFixture();
    const key = buildEmbeddingCacheKey(input);
    expect(await cache.get(key, input)).toEqual({ outcome: 'miss' });
    await cache.set(key, input, [0.1, 0.2, 0.3]);
    expect(await cache.get(key, input)).toEqual({ outcome: 'hit', vector: [0.1, 0.2, 0.3] });
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, sets: 1 });
  });

  it('rejects stale versions instead of serving them', async () => {
    const cache = createInMemoryEmbeddingCache();
    const input = inputFixture();
    const key = buildEmbeddingCacheKey(input);
    const variants = [
      inputFixture({ embeddingModelVersion: 'v4' }),
      inputFixture({ dimensions: 4 }),
      inputFixture({ tenantId: 'tenant-b' }),
    ];
    for (const variant of variants) {
      await cache.set(key, input, [0.1, 0.2, 0.3]);
      expect(await cache.get(key, variant)).toEqual({ outcome: 'stale_version' });
    }
    expect(cache.stats().staleVersions).toBe(3);
    await cache.set(key, input, [0.1, 0.2, 0.3]);
    expect(await cache.get(key, input)).toEqual({ outcome: 'hit', vector: [0.1, 0.2, 0.3] });
  });

  it('expires entries after the TTL', async () => {
    const cache = createInMemoryEmbeddingCache({ ttlMs: 10 });
    const input = inputFixture();
    const key = buildEmbeddingCacheKey(input);
    await cache.set(key, input, [0.1, 0.2, 0.3]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await cache.get(key, input)).toEqual({ outcome: 'miss' });
  });

  it('rejects dimension-mismatched vectors without throwing', async () => {
    const cache = createInMemoryEmbeddingCache();
    const input = inputFixture();
    const key = buildEmbeddingCacheKey(input);
    await cache.set(key, input, [0.1, 0.2]);
    expect(await cache.get(key, input)).toEqual({ outcome: 'miss' });
    expect(cache.stats().errors).toBe(1);
  });

  it('evicts oldest entries past the cap', async () => {
    const cache = createInMemoryEmbeddingCache({ maxEntries: 2 });
    for (const ordinal of [1, 2, 3]) {
      const input = inputFixture({ normalizedQuery: `query ${ordinal}` });
      await cache.set(buildEmbeddingCacheKey(input), input, [0.1, 0.2, 0.3]);
    }
    expect(cache.size()).toBe(2);
  });
});

describe('redis embedding cache', () => {
  it('round-trips through a Redis-compatible client', async () => {
    const client = fakeRedisClient();
    const cache = createRedisEmbeddingCache(client);
    const input = inputFixture();
    const key = buildEmbeddingCacheKey(input);
    expect(await cache.get(key, input)).toEqual({ outcome: 'miss' });
    await cache.set(key, input, [0.4, 0.5, 0.6]);
    expect(await cache.get(key, input)).toEqual({ outcome: 'hit', vector: [0.4, 0.5, 0.6] });
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, sets: 1 });
  });

  it('degrades to counted misses instead of throwing when Redis fails', async () => {
    const cache = createRedisEmbeddingCache(failingClient());
    const input = inputFixture();
    const key = buildEmbeddingCacheKey(input);
    expect(await cache.get(key, input)).toEqual({ outcome: 'error_degraded' });
    await cache.set(key, input, [0.1, 0.2, 0.3]);
    expect(cache.stats().errors).toBe(2);
  });

  it('treats malformed envelopes as stale versions', async () => {
    const client = fakeRedisClient();
    client.entries.set('bad-key', '{not json');
    const cache = createRedisEmbeddingCache(client);
    expect(await cache.get('bad-key', inputFixture())).toEqual({ outcome: 'stale_version' });
  });
});
