import { createHash } from 'node:crypto';
import { z } from 'zod';
import { logger } from '@app/domain';

/**
 * Retrieval-candidate cache adapter (WP-8 Task B, F-34).
 *
 * Reuses candidate ids and scores for repeated searches. Keys include the
 * tenant, corpus/index versions, the normalized query, the modality, the
 * request filter hash, and the retrieval configuration version. Cached entries
 * retain score and query provenance (`queryId`, `subquestionId`, per-signal
 * scores) so downstream fusion keeps its provenance after a cache hit.
 *
 * Entries store ids and scores only, never document text. Dedup and backfill
 * stay turn-local: the caller loads cached candidates and then applies its
 * own already-seen exclusion within its budgets. Version mismatches and TTL
 * expiry are misses with explicit counters.
 *
 * Failure mode is fail-open with counted degradation, matching the matrix
 * policy for this optional layer. Independent `retrievalCacheEnabled` gating
 * lives in the application matrix; this adapter is storage only.
 */

export const RETRIEVAL_CANDIDATE_CACHE_VERSION = 'retrieval-candidate-cache-v1' as const;
export const RETRIEVAL_CANDIDATE_TTL_SECONDS = 30 * 60;

export const CandidateModalitySchema = z.enum(['vector', 'lexical', 'fused']);
export type CandidateModality = z.infer<typeof CandidateModalitySchema>;

export const RetrievalCandidateKeyInputSchema = z.object({
  tenantId: z.string().min(1).max(200),
  corpusVersion: z.string().min(1).max(200),
  indexVersion: z.string().min(1).max(200),
  normalizedQuery: z.string().min(1).max(2_000),
  modality: CandidateModalitySchema,
  filterHash: z.string().min(1).max(200),
  retrievalConfigVersion: z.string().min(1).max(200),
});
export type RetrievalCandidateKeyInput = z.infer<typeof RetrievalCandidateKeyInputSchema>;

/** Versioned key: tenant/corpus/index + query + modality + filter + config. */
export function buildRetrievalCandidateCacheKey(input: unknown): string {
  const parsed = RetrievalCandidateKeyInputSchema.parse(input);
  const queryHash = createHash('sha256').update(parsed.normalizedQuery, 'utf8').digest('hex').slice(0, 32);
  return `rc:${RETRIEVAL_CANDIDATE_CACHE_VERSION}:t${parsed.tenantId}:c${parsed.corpusVersion}:i${parsed.indexVersion}:${parsed.modality}:f${parsed.filterHash}:v${parsed.retrievalConfigVersion}:q${queryHash}`;
}

export const CachedCandidateScoresSchema = z.object({
  dense: z.number().finite().optional(),
  lexical: z.number().finite().optional(),
  fusion: z.number().finite().optional(),
  reranker: z.number().finite().optional(),
  finalRank: z.number().int().min(0),
  finalSignal: z.enum(['dense', 'lexical', 'fusion', 'reranker']),
});
export type CachedCandidateScores = z.infer<typeof CachedCandidateScoresSchema>;

export const CachedCandidateSchema = z.object({
  chunkUid: z.string().min(1).max(200).optional(),
  documentId: z.number().int().min(0),
  chunkIndex: z.number().int().min(0),
  queryId: z.string().min(1).max(200),
  subquestionId: z.string().min(1).max(200),
  scores: CachedCandidateScoresSchema,
});
export type CachedCandidate = z.infer<typeof CachedCandidateSchema>;

export const StoredCandidateSetSchema = z.object({
  cacheVersion: z.literal(RETRIEVAL_CANDIDATE_CACHE_VERSION),
  tenantId: z.string().min(1),
  corpusVersion: z.string().min(1),
  indexVersion: z.string().min(1),
  retrievalConfigVersion: z.string().min(1),
  modality: CandidateModalitySchema,
  candidates: z.array(CachedCandidateSchema).max(500),
  storedAt: z.number().int().min(0),
});
export type StoredCandidateSet = z.infer<typeof StoredCandidateSetSchema>;

export type RetrievalCandidateLookup =
  | { readonly outcome: 'hit'; readonly candidates: readonly CachedCandidate[] }
  | { readonly outcome: 'miss' }
  | { readonly outcome: 'stale_version' }
  | { readonly outcome: 'error_degraded' };

export interface RetrievalCandidateCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly sets: number;
  readonly staleVersions: number;
  readonly errors: number;
}

export interface RetrievalCandidateCacheStore {
  get(key: string, expected: RetrievalCandidateKeyInput): Promise<RetrievalCandidateLookup>;
  set(key: string, input: RetrievalCandidateKeyInput, candidates: readonly CachedCandidate[]): Promise<void>;
  stats(): RetrievalCandidateCacheStats;
}

function emptyStats(): { hits: number; misses: number; sets: number; staleVersions: number; errors: number } {
  return { hits: 0, misses: 0, sets: 0, staleVersions: 0, errors: 0 };
}

function lookupStored(
  raw: StoredCandidateSet,
  expected: RetrievalCandidateKeyInput,
  now: number,
  ttlMs: number,
): RetrievalCandidateLookup {
  if (
    raw.tenantId !== expected.tenantId ||
    raw.corpusVersion !== expected.corpusVersion ||
    raw.indexVersion !== expected.indexVersion ||
    raw.retrievalConfigVersion !== expected.retrievalConfigVersion ||
    raw.modality !== expected.modality
  ) {
    return Object.freeze({ outcome: 'stale_version' });
  }
  if (raw.storedAt + ttlMs <= now) return Object.freeze({ outcome: 'miss' });
  return Object.freeze({ outcome: 'hit', candidates: Object.freeze([...raw.candidates]) });
}

export function createInMemoryRetrievalCandidateCache(
  options: { readonly ttlMs?: number | undefined; readonly maxEntries?: number | undefined } = {},
): RetrievalCandidateCacheStore & { readonly size: () => number } {
  const ttlMs = options.ttlMs ?? RETRIEVAL_CANDIDATE_TTL_SECONDS * 1_000;
  const maxEntries = options.maxEntries ?? 2_000;
  const entries = new Map<string, StoredCandidateSet>();
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

  function count(lookup: RetrievalCandidateLookup, key: string): RetrievalCandidateLookup {
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
        throw new Error(
          `retrieval-candidate-cache: unhandled lookup ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }

  return {
    get: async (key: string, expected: RetrievalCandidateKeyInput): Promise<RetrievalCandidateLookup> => {
      const stored = entries.get(key);
      if (stored === undefined) {
        counters.misses += 1;
        return Object.freeze({ outcome: 'miss' });
      }
      return count(lookupStored(stored, expected, Date.now(), ttlMs), key);
    },
    set: async (
      key: string,
      input: RetrievalCandidateKeyInput,
      candidates: readonly CachedCandidate[],
    ): Promise<void> => {
      let validated: readonly CachedCandidate[];
      try {
        validated = Object.freeze(z.array(CachedCandidateSchema).max(500).parse([...candidates]));
      } catch {
        counters.errors += 1;
        logger.warn('retrieval.candidate_set_rejected', { candidateCount: candidates.length });
        return;
      }
      evictIfNeeded();
      entries.set(key, {
        cacheVersion: RETRIEVAL_CANDIDATE_CACHE_VERSION,
        tenantId: input.tenantId,
        corpusVersion: input.corpusVersion,
        indexVersion: input.indexVersion,
        retrievalConfigVersion: input.retrievalConfigVersion,
        modality: input.modality,
        candidates: [...validated],
        storedAt: Date.now(),
      });
      counters.sets += 1;
    },
    stats: (): RetrievalCandidateCacheStats => Object.freeze({ ...counters }),
    size: () => entries.size,
  };
}

/** Structural Redis client (Upstash-compatible). Failures degrade to misses. */
export interface RetrievalCandidateRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { readonly ex?: number | undefined }): Promise<unknown>;
}

export function createRedisRetrievalCandidateCache(
  client: RetrievalCandidateRedisClient,
  options: { readonly ttlSeconds?: number | undefined } = {},
): RetrievalCandidateCacheStore {
  const ttlSeconds = options.ttlSeconds ?? RETRIEVAL_CANDIDATE_TTL_SECONDS;
  const counters = emptyStats();

  return {
    get: async (key: string, expected: RetrievalCandidateKeyInput): Promise<RetrievalCandidateLookup> => {
      let raw: string | null;
      try {
        raw = await client.get(key);
      } catch (error) {
        counters.errors += 1;
        logger.warn('retrieval.candidate_redis_degraded', {
          op: 'get',
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        return Object.freeze({ outcome: 'error_degraded' });
      }
      if (raw === null) {
        counters.misses += 1;
        return Object.freeze({ outcome: 'miss' });
      }
      let parsed: StoredCandidateSet;
      try {
        // Upstash auto-deserializes stored JSON on read (see upstash-answer-cache),
        // so a live client may hand back the envelope object instead of a string.
        parsed = StoredCandidateSetSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
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
          throw new Error(
            `retrieval-candidate-cache: unhandled lookup ${JSON.stringify(exhaustive)}`,
          );
        }
      }
    },
    set: async (
      key: string,
      input: RetrievalCandidateKeyInput,
      candidates: readonly CachedCandidate[],
    ): Promise<void> => {
      let validated: StoredCandidateSet['candidates'];
      try {
        validated = z.array(CachedCandidateSchema).max(500).parse([...candidates]);
      } catch {
        counters.errors += 1;
        return;
      }
      const envelope: StoredCandidateSet = {
        cacheVersion: RETRIEVAL_CANDIDATE_CACHE_VERSION,
        tenantId: input.tenantId,
        corpusVersion: input.corpusVersion,
        indexVersion: input.indexVersion,
        retrievalConfigVersion: input.retrievalConfigVersion,
        modality: input.modality,
        candidates: validated,
        storedAt: Date.now(),
      };
      try {
        await client.set(key, JSON.stringify(envelope), { ex: ttlSeconds });
        counters.sets += 1;
      } catch (error) {
        counters.errors += 1;
        logger.warn('retrieval.candidate_redis_degraded', {
          op: 'set',
          errorName: error instanceof Error ? error.name : 'unknown',
        });
      }
    },
    stats: (): RetrievalCandidateCacheStats => Object.freeze({ ...counters }),
  };
}
