import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingService } from '@app/domain';
import { createInMemoryEmbeddingCache } from '../embedding-cache';
import {
  createCachedEmbeddingService,
  DEPLOYMENT_TENANT_ID,
  resolveEmbeddingModelVersion,
  normalizeEmbeddingQuery,
  type CachedEmbeddingServiceContext,
} from '../cached-embedding-service';

function contextFixture(overrides: Partial<CachedEmbeddingServiceContext> = {}): CachedEmbeddingServiceContext {
  return {
    tenantId: DEPLOYMENT_TENANT_ID,
    modelId: 'gemini-embedding-001',
    modelVersion: 'v1',
    dimensions: 3,
    ...overrides,
  };
}

interface FakeEmbeddings extends EmbeddingService {
  readonly embedCalls: string[];
  readonly batchCalls: string[][];
}

function fakeEmbeddings(vectorFor: (text: string) => number[] = (text) => [text.length, 0.5, -0.5]): FakeEmbeddings {
  const embedCalls: string[] = [];
  const batchCalls: string[][] = [];
  return {
    embedCalls,
    batchCalls,
    embed: async (value: string) => {
      embedCalls.push(value);
      return [...vectorFor(value)];
    },
    embedBatch: async (values: string[]) => {
      batchCalls.push([...values]);
      return values.map((value) => [...vectorFor(value)]);
    },
  };
}

function throwingStore(): { get: () => Promise<never>; set: () => Promise<never>; stats: () => never } {
  return {
    get: async () => {
      throw new Error('redis down');
    },
    set: async () => {
      throw new Error('redis down');
    },
    stats: () => {
      throw new Error('unreachable');
    },
  };
}

describe('resolveEmbeddingModelVersion', () => {
  it('reads the pinned env value and falls back to v1', () => {
    expect(resolveEmbeddingModelVersion({ get: () => '2026-05' })).toBe('2026-05');
    expect(resolveEmbeddingModelVersion({ get: () => undefined })).toBe('v1');
    expect(resolveEmbeddingModelVersion({ get: () => '   ' })).toBe('v1');
  });
});

describe('normalizeEmbeddingQuery', () => {
  it('trims, lowercases, and collapses whitespace like the answer-cache key', () => {
    expect(normalizeEmbeddingQuery('  How  do REFUNDS  work ? ')).toBe('how do refunds work?');
  });
});

describe('createCachedEmbeddingService', () => {
  it('rejects invalid binding contexts fail-fast', () => {
    const embeddings = fakeEmbeddings();
    const store = createInMemoryEmbeddingCache();
    expect(() => createCachedEmbeddingService(embeddings, store, contextFixture({ modelId: '' }))).toThrow();
    expect(() => createCachedEmbeddingService(embeddings, store, contextFixture({ dimensions: 0 }))).toThrow();
    expect(() => createCachedEmbeddingService(embeddings, store, contextFixture({ modelVersion: '' }))).toThrow();
  });

  it('computes on miss and serves hits without recompute', async () => {
    const embeddings = fakeEmbeddings();
    const store = createInMemoryEmbeddingCache();
    const cached = createCachedEmbeddingService(embeddings, store, contextFixture());
    const first = await cached.embed('how do refunds work');
    expect(first).toEqual([19, 0.5, -0.5]);
    const second = await cached.embed('  HOW  do refunds work ');
    expect(second).toEqual(first);
    expect(embeddings.embedCalls).toHaveLength(1);
    expect(store.stats()).toMatchObject({ hits: 1, misses: 1, sets: 1 });
    expect(cached.stats()).toMatchObject({ hits: 1, misses: 1, sets: 1 });
  });

  it('scopes keys by tenant, model, version, and dimensions', async () => {
    const embeddings = fakeEmbeddings();
    const store = createInMemoryEmbeddingCache();
    const base = contextFixture();
    const a = createCachedEmbeddingService(embeddings, store, base);
    const b = createCachedEmbeddingService(embeddings, store, contextFixture({ tenantId: 'other' }));
    const c = createCachedEmbeddingService(embeddings, store, contextFixture({ modelVersion: 'v2' }));
    await a.embed('shared query');
    await b.embed('shared query');
    await c.embed('shared query');
    expect(embeddings.embedCalls).toHaveLength(3);
  });

  it('degrades to compute when the store throws, without throwing', async () => {
    const embeddings = fakeEmbeddings();
    const broken = throwingStore();
    const cached = createCachedEmbeddingService(
      embeddings,
      broken as unknown as ReturnType<typeof createInMemoryEmbeddingCache>,
      contextFixture(),
    );
    expect(await cached.embed('refund policy')).toEqual([13, 0.5, -0.5]);
    expect(await cached.embed('refund policy')).toEqual([13, 0.5, -0.5]);
    expect(embeddings.embedCalls).toHaveLength(2);
  });

  it('bypasses the cache for empty and overlong queries', async () => {
    const embeddings = fakeEmbeddings();
    const store = createInMemoryEmbeddingCache();
    const getSpy = vi.spyOn(store, 'get');
    const setSpy = vi.spyOn(store, 'set');
    const cached = createCachedEmbeddingService(embeddings, store, contextFixture());
    await cached.embed('   ');
    await cached.embed('x'.repeat(4_001));
    expect(embeddings.embedCalls).toHaveLength(2);
    expect(getSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('propagates provider compute errors and cleans up single-flight state', async () => {
    const embeddings = fakeEmbeddings();
    embeddings.embed = async () => {
      throw new Error('provider outage');
    };
    const store = createInMemoryEmbeddingCache();
    const cached = createCachedEmbeddingService(embeddings, store, contextFixture());
    await expect(cached.embed('refund policy')).rejects.toThrow('provider outage');
    expect(cached.pendingCount()).toBe(0);
  });

  it('coalesces concurrent embeds for the same key into one provider call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const embeddings = fakeEmbeddings();
    embeddings.embed = async (value: string) => {
      embeddings.embedCalls.push(value);
      await gate;
      return [1, 2, 3];
    };
    const store = createInMemoryEmbeddingCache();
    const cached = createCachedEmbeddingService(embeddings, store, contextFixture());
    const pending = [cached.embed('same query'), cached.embed('same query'), cached.embed('same query')];
    // Drain microtasks so every caller finishes its (missed) store lookup and
    // attaches to the shared in-flight computation before the gate opens.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(embeddings.embedCalls).toHaveLength(1);
    expect(cached.pendingCount()).toBe(1);
    release();
    const results = await Promise.all(pending);
    expect(embeddings.embedCalls).toHaveLength(1);
    expect(results).toEqual([[1, 2, 3], [1, 2, 3], [1, 2, 3]]);
    expect(cached.pendingCount()).toBe(0);
  });

  it('batch-computes misses in one provider call, preserves order, then serves hits', async () => {
    const embeddings = fakeEmbeddings();
    const store = createInMemoryEmbeddingCache();
    const cached = createCachedEmbeddingService(embeddings, store, contextFixture());
    const first = await cached.embedBatch(['aaa', 'b', 'ccccc']);
    expect(first).toEqual([[3, 0.5, -0.5], [1, 0.5, -0.5], [5, 0.5, -0.5]]);
    expect(embeddings.batchCalls).toHaveLength(1);
    const second = await cached.embedBatch(['ccccc', 'new query', 'aaa']);
    expect(second).toEqual([[5, 0.5, -0.5], [9, 0.5, -0.5], [3, 0.5, -0.5]]);
    expect(embeddings.batchCalls).toHaveLength(2);
    expect(embeddings.batchCalls[1]).toEqual(['new query']);
    expect(await cached.embedBatch([])).toEqual([]);
  });

  it('degrades batch cache failures to compute without throwing', async () => {
    const embeddings = fakeEmbeddings();
    const broken = throwingStore();
    const cached = createCachedEmbeddingService(
      embeddings,
      broken as unknown as ReturnType<typeof createInMemoryEmbeddingCache>,
      contextFixture(),
    );
    expect(await cached.embedBatch(['aa', 'bbbb'])).toEqual([[2, 0.5, -0.5], [4, 0.5, -0.5]]);
    expect(embeddings.batchCalls).toHaveLength(1);
  });

  it('still returns the vector when the store rejects the write (dimension mismatch)', async () => {
    const embeddings = fakeEmbeddings(() => [1, 2, 3, 4, 5]);
    const store = createInMemoryEmbeddingCache();
    const cached = createCachedEmbeddingService(embeddings, store, contextFixture({ dimensions: 3 }));
    expect(await cached.embed('refund policy')).toEqual([1, 2, 3, 4, 5]);
    expect(store.stats().errors).toBe(1);
    expect(store.stats().sets).toBe(0);
  });

  it('exposes the frozen binding context for wiring verification', () => {
    const cached = createCachedEmbeddingService(fakeEmbeddings(), createInMemoryEmbeddingCache(), contextFixture());
    expect(cached.describe()).toEqual(contextFixture());
    expect(Object.isFrozen(cached.describe())).toBe(true);
  });
});
