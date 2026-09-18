import { createHash } from 'node:crypto';
import { z } from 'zod';
import { logger } from '@app/domain';

/**
 * Embedding cache adapter (WP-8 Task B, F-34).
 *
 * Reuses query embeddings across turns and subquestions. Keys include the
 * tenant, the normalized query, and the embedding model/version/dimensions so
 * a model change can never serve stale vectors. Version mismatches and TTL
 * expiry are misses with explicit counters, never served data.
 *
 * Failure mode is fail-open: storage errors return a miss (the caller
 * recomputes) and are counted, never thrown to the interactive path. Tenant
 * isolation holds by key construction; reads validate the stored tenant.
 * Turn-local dedup/backfill is the caller's job and never lives here.
 *
 * Two stores share one contract: an in-memory TTL store (tests, single-flight
 * fallback) and a structural Redis client interface compatible with Upstash
 * (`get`/`set` with `EX`). No provider option keys live in this module.
 */

export const EMBEDDING_CACHE_VERSION = 'embedding-cache-v1' as const;
export const EMBEDDING_CACHE_TTL_SECONDS = 24 * 60 * 60;

export const EmbeddingKeyInputSchema = z.object({
  tenantId: z.string().min(1).max(200),
  normalizedQuery: z.string().min(1).max(4_000),
  embeddingModelId: z.string().min(1).max(200),
  embeddingModelVersion: z.string().min(1).max(200),
  dimensions: z.number().int().positive().max(10_000),
});
export type EmbeddingKeyInput = z.infer<typeof EmbeddingKeyInputSchema>;

/** Versioned key: tenant + normalized query + model/version/dimensions. */
export function buildEmbeddingCacheKey(input: unknown): string {
  const parsed = EmbeddingKeyInputSchema.parse(input);
  const queryHash = createHash('sha256').update(parsed.normalizedQuery, 'utf8').digest('hex').slice(0, 32);
  return `emb:${EMBEDDING_CACHE_VERSION}:t${parsed.tenantId}:m${parsed.embeddingModelId}:v${parsed.embeddingModelVersion}:d${parsed.dimensions}:q${queryHash}`;
}

export const StoredEmbeddingSchema = z.object({
  cacheVersion: z.literal(EMBEDDING_CACHE_VERSION),
  tenantId: z.string().min(1),
  embeddingModelId: z.string().min(1),
  embeddingModelVersion: z.string().min(1),
  dimensions: z.number().int().positive(),
  vector: z.array(z.number().finite()).min(1).max(10_000),
  storedAt: z.number().int().min(0),
});
export type StoredEmbedding = z.infer<typeof StoredEmbeddingSchema>;

export type EmbeddingCacheLookup =
  | { readonly outcome: 'hit'; readonly vector: readonly number[] }
  | { readonly outcome: 'miss' }
  | { readonly outcome: 'stale_version' }
  | { readonly outcome: 'error_degraded' };

export interface EmbeddingCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly sets: number;
  readonly staleVersions: number;
  readonly errors: number;
}

export interface EmbeddingCacheStore {
  get(key: string, expected: EmbeddingKeyInput): Promise<EmbeddingCacheLookup>;
  set(key: string, input: EmbeddingKeyInput, vector: readonly number[]): Promise<void>;
  stats(): EmbeddingCacheStats;
}

function emptyStats(): { hits: number; misses: number; sets: number; staleVersions: number; errors: number } {
  return { hits: 0, misses: 0, sets: 0, staleVersions: 0, errors: 0 };
}

function lookupStored(
  raw: StoredEmbedding,
  expected: EmbeddingKeyInput,
  now: number,
  ttlMs: number,
): EmbeddingCacheLookup {
  if (
    raw.tenantId !== expected.tenantId ||
    raw.embeddingModelId !== expected.embeddingModelId ||
    raw.embeddingModelVersion !== expected.embeddingModelVersion ||
    raw.dimensions !== expected.dimensions ||
    raw.vector.length !== expected.dimensions
  ) {
    return Object.freeze({ outcome: 'stale_version' });
  }
  if (raw.storedAt + ttlMs <= now) return Object.freeze({ outcome: 'miss' });
  return Object.freeze({ outcome: 'hit', vector: Object.freeze([...raw.vector]) });
}

export function createInMemoryEmbeddingCache(
  options: { readonly ttlMs?: number | undefined; readonly maxEntries?: number | undefined } = {},
): EmbeddingCacheStore & { readonly size: () => number } {
  const ttlMs = options.ttlMs ?? EMBEDDING_CACHE_TTL_SECONDS * 1_000;
  const maxEntries = options.maxEntries ?? 5_000;
  const entries = new Map<string, StoredEmbedding>();
  const counters = emptyStats();

  function evictIfNeeded(): void {
    if (entries.size < maxEntries) return;
    const now = Date.now();
    for (const [key, stored] of entries) {
      if (stored.storedAt + ttlMs <= now) entries.delete(key);
    }
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    get: async (key: string, expected: EmbeddingKeyInput): Promise<EmbeddingCacheLookup> => {
      const stored = entries.get(key);
      if (stored === undefined) {
        counters.misses += 1;
        return Object.freeze({ outcome: 'miss' });
      }
      const lookup = lookupStored(stored, expected, Date.now(), ttlMs);
      switch (lookup.outcome) {
        case 'hit':
          counters.hits += 1;
          return lookup;
        case 'stale_version':
          counters.staleVersions += 1;
          entries.delete(key);
          return lookup;
        case 'miss':
          counters.misses += 1;
          entries.delete(key);
          return lookup;
        case 'error_degraded':
          return lookup;
        default: {
          const exhaustive: never = lookup;
          throw new Error(`embedding-cache: unhandled lookup ${JSON.stringify(exhaustive)}`);
        }
      }
    },
    set: async (key: string, input: EmbeddingKeyInput, vector: readonly number[]): Promise<void> => {
      if (vector.length !== input.dimensions) {
        counters.errors += 1;
        logger.warn('embedding.cache_dimension_rejected', { dimensions: input.dimensions, vectorLength: vector.length });
        return;
      }
      evictIfNeeded();
      entries.set(key, {
        cacheVersion: EMBEDDING_CACHE_VERSION,
        tenantId: input.tenantId,
        embeddingModelId: input.embeddingModelId,
        embeddingModelVersion: input.embeddingModelVersion,
        dimensions: input.dimensions,
        vector: [...vector],
        storedAt: Date.now(),
      });
      counters.sets += 1;
    },
    stats: (): EmbeddingCacheStats => Object.freeze({ ...counters }),
    size: () => entries.size,
  };
}

/** Structural Redis client (Upstash-compatible). Failures degrade to misses. */
export interface EmbeddingCacheRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { readonly ex?: number | undefined }): Promise<unknown>;
}

export function createRedisEmbeddingCache(
  client: EmbeddingCacheRedisClient,
  options: { readonly ttlSeconds?: number | undefined } = {},
): EmbeddingCacheStore {
  const ttlSeconds = options.ttlSeconds ?? EMBEDDING_CACHE_TTL_SECONDS;
  const counters = emptyStats();

  return {
    get: async (key: string, expected: EmbeddingKeyInput): Promise<EmbeddingCacheLookup> => {
      let raw: string | null;
      try {
        raw = await client.get(key);
      } catch (error) {
        counters.errors += 1;
        logger.warn('embedding.cache_redis_degraded', { op: 'get', errorName: error instanceof Error ? error.name : 'unknown' });
        return Object.freeze({ outcome: 'error_degraded' });
      }
      if (raw === null) {
        counters.misses += 1;
        return Object.freeze({ outcome: 'miss' });
      }
      let parsed: StoredEmbedding;
      try {
        parsed = StoredEmbeddingSchema.parse(JSON.parse(raw));
      } catch {
        counters.staleVersions += 1;
        return Object.freeze({ outcome: 'stale_version' });
      }
      const lookup = lookupStored(parsed, expected, Date.now(), ttlSeconds * 1_000);
      switch (lookup.outcome) {
        case 'hit':
          counters.hits += 1;
          return lookup;
        case 'stale_version':
          counters.staleVersions += 1;
          return lookup;
        case 'miss':
          counters.misses += 1;
          return lookup;
        case 'error_degraded':
          return lookup;
        default: {
          const exhaustive: never = lookup;
          throw new Error(`embedding-cache: unhandled lookup ${JSON.stringify(exhaustive)}`);
        }
      }
    },
    set: async (key: string, input: EmbeddingKeyInput, vector: readonly number[]): Promise<void> => {
      if (vector.length !== input.dimensions) {
        counters.errors += 1;
        return;
      }
      const envelope: StoredEmbedding = {
        cacheVersion: EMBEDDING_CACHE_VERSION,
        tenantId: input.tenantId,
        embeddingModelId: input.embeddingModelId,
        embeddingModelVersion: input.embeddingModelVersion,
        dimensions: input.dimensions,
        vector: [...vector],
        storedAt: Date.now(),
      };
      try {
        await client.set(key, JSON.stringify(envelope), { ex: ttlSeconds });
        counters.sets += 1;
      } catch (error) {
        counters.errors += 1;
        logger.warn('embedding.cache_redis_degraded', { op: 'set', errorName: error instanceof Error ? error.name : 'unknown' });
      }
    },
    stats: (): EmbeddingCacheStats => Object.freeze({ ...counters }),
  };
}
