import type { EmbeddingService, EnvSource } from '@app/domain';
import {
  buildEmbeddingCacheKey,
  type EmbeddingCacheStats,
  type EmbeddingCacheStore,
  type EmbeddingKeyInput,
} from './embedding-cache';

/**
 * Cached embedding decorator (WP-9 workstream B, F-34 wiring preparation).
 *
 * Wraps any {@link EmbeddingService} with a read-through/write-through
 * embedding cache. Zero production callers yet: the coordinator connects this
 * in `getSearchDeps` (see the wiring snippet in the workstream return text).
 *
 * Failure contract (matches docs/runtime/cache-matrix.md):
 * - Cache misses, stale versions, TTL expiry, and storage errors degrade to
 *   a provider compute. Cache-path failures NEVER throw to the caller.
 * - Provider compute failures ARE real errors and propagate unchanged (the
 *   caller maps them to `embedding_unavailable`, preserving today's behavior).
 * - Uncacheable inputs (empty after normalization, longer than the key schema
 *   allows) bypass the cache and compute directly, never throw.
 *
 * Single-flight: concurrent `embed()`/`embedBatch()` calls for the same
 * normalized key share one provider call via a process-local in-flight map.
 * The map is self-cleaning (entries are removed in `finally` once settled).
 * Distributed single-flight across instances is explicitly future work: two
 * instances may compute the same query concurrently. That only costs a
 * duplicate provider call (writes are idempotent), never correctness, because
 * the stored envelope revalidates tenant/model/version/dimensions on read.
 *
 * Tenancy: Destr is a single-deployment installation with one
 * deployment-wide knowledge corpus (see CONTEXT.md). There is no tenant
 * dimension in the product, so callers pass {@link DEPLOYMENT_TENANT_ID} as
 * the tenant namespace. The tenant field is still part of every key and is
 * revalidated on read, so a future multi-deployment split only needs a real
 * tenant id here, not a key-format change.
 *
 * Model version: no provider exposes a weight version (investigation
 * 2026-09-19: OpenAI/Google/Ollama adapters only know the model id string
 * plus `EMBEDDING_DIMENSION`; no `*_MODEL_VERSION` exists anywhere). The
 * version therefore comes from {@link resolveEmbeddingModelVersion} and MUST
 * be rotated manually (see its docs). Model id or dimension changes
 * invalidate automatically via the key; only silent same-id weight changes
 * need the manual bump.
 *
 * Normalization mirrors `answerCacheKey`
 * (packages/infrastructure/src/auth/answer-cache-key.ts): trim, lowercase,
 * collapse whitespace, tighten punctuation. The application-side candidate
 * port (`candidate-cache-port.ts`) duplicates this 5-line algorithm because
 * the layering rules forbid sharing it; keep the two in sync.
 */

export const DEPLOYMENT_TENANT_ID = 'deployment' as const;

export const EMBEDDING_MODEL_VERSION_ENV_KEY = 'EMBEDDING_MODEL_VERSION' as const;

/**
 * Fallback model version used when the deployment does not pin
 * `EMBEDDING_MODEL_VERSION`. MUST-ROTATE procedure: whenever the embedding
 * provider changes weights under a stable model id (versioned releases,
 * `*-latest` aliases, unannounced refreshes), bump the pinned value and
 * either flush the `emb:*` Redis keys or wait out the 24h TTL. Serving stale
 * vectors only risks slightly shifted retrieval scores (fail-open quality
 * degradation), never ungrounded answers: verified-only answer release is
 * enforced elsewhere.
 */
export const EMBEDDING_MODEL_VERSION_FALLBACK = 'v1' as const;

export function resolveEmbeddingModelVersion(env: EnvSource): string {
  const raw = env.get(EMBEDDING_MODEL_VERSION_ENV_KEY)?.trim();
  return raw !== undefined && raw !== '' ? raw : EMBEDDING_MODEL_VERSION_FALLBACK;
}

/** Query normalization shared with the answer-cache key (see module docs). */
export function normalizeEmbeddingQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s+([?.!,;:])/g, '$1')
    .trim();
}

export interface CachedEmbeddingServiceContext {
  readonly tenantId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly dimensions: number;
}

export interface CachedEmbeddingService extends EmbeddingService {
  /** Passthrough to the underlying store counters (hit/miss/set/stale/error). */
  stats(): EmbeddingCacheStats;
  /** Process-local in-flight computations (single-flight telemetry). */
  pendingCount(): number;
  /** Frozen copy of the binding context (tenant/model/version/dimensions). */
  describe(): CachedEmbeddingServiceContext;
}

interface KeyMaterial {
  readonly key: string;
  readonly input: EmbeddingKeyInput;
}

function validateContext(context: CachedEmbeddingServiceContext): void {
  if (context.tenantId.trim() === '') throw new Error('cached-embedding-service: tenantId must not be empty');
  if (context.modelId.trim() === '') throw new Error('cached-embedding-service: modelId must not be empty');
  if (context.modelVersion.trim() === '') {
    throw new Error('cached-embedding-service: modelVersion must not be empty');
  }
  if (!Number.isInteger(context.dimensions) || context.dimensions <= 0 || context.dimensions > 10_000) {
    throw new Error('cached-embedding-service: dimensions must be a positive integer');
  }
}

export function createCachedEmbeddingService(
  embeddings: EmbeddingService,
  store: EmbeddingCacheStore,
  context: CachedEmbeddingServiceContext,
): CachedEmbeddingService {
  validateContext(context);
  const frozenContext: CachedEmbeddingServiceContext = Object.freeze({ ...context });
  const inflight = new Map<string, Promise<readonly number[]>>();

  function tryBuildKey(value: string): KeyMaterial | null {
    const normalizedQuery = normalizeEmbeddingQuery(value);
    if (normalizedQuery === '') return null;
    try {
      const input: EmbeddingKeyInput = {
        tenantId: frozenContext.tenantId,
        normalizedQuery,
        embeddingModelId: frozenContext.modelId,
        embeddingModelVersion: frozenContext.modelVersion,
        dimensions: frozenContext.dimensions,
      };
      return { key: buildEmbeddingCacheKey(input), input };
    } catch {
      // Overlong queries (or any future schema tightening) bypass the cache.
      return null;
    }
  }

  async function safeGet(material: KeyMaterial): Promise<readonly number[] | null> {
    try {
      const lookup = await store.get(material.key, material.input);
      return lookup.outcome === 'hit' ? lookup.vector : null;
    } catch {
      return null;
    }
  }

  async function safeSet(material: KeyMaterial, vector: readonly number[]): Promise<void> {
    try {
      await store.set(material.key, material.input, vector);
    } catch {
      // Best-effort write; the caller already holds the computed vector.
    }
  }

  function computeOnce(
    material: KeyMaterial,
    value: string,
    opts: { signal?: AbortSignal } | undefined,
  ): Promise<readonly number[]> {
    const existing = inflight.get(material.key);
    if (existing !== undefined) return existing;
    const task: Promise<readonly number[]> = (async () => {
      const vector = await embeddings.embed(value, opts);
      await safeSet(material, vector);
      return Object.freeze([...vector]);
    })();
    inflight.set(material.key, task);
    const guarded = task.then(
      (vector) => {
        if (inflight.get(material.key) === task) inflight.delete(material.key);
        return vector;
      },
      (error: unknown) => {
        if (inflight.get(material.key) === task) inflight.delete(material.key);
        throw error;
      },
    );
    return guarded;
  }

  async function embedWithCache(value: string, opts: { signal?: AbortSignal } = {}): Promise<number[]> {
    const material = tryBuildKey(value);
    if (material === null) return embeddings.embed(value, opts);
    const cached = await safeGet(material);
    if (cached !== null) return [...cached];
    return [...(await computeOnce(material, value, opts))];
  }

  async function embedBatchWithCache(
    values: string[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<number[][]> {
    if (values.length === 0) return [];
    const materials = values.map(tryBuildKey);
    const cached = await Promise.all(materials.map((m) => (m === null ? null : safeGet(m))));
    const settled: Array<readonly number[] | undefined> = cached.map((hit) => hit ?? undefined);
    const pending = new Map<number, Promise<readonly number[]>>();
    const owned: Array<{ key: string; promise: Promise<readonly number[]> }> = [];
    const preexisting = new Set<number>();
    const computeIndices: number[] = [];
    for (const [index] of values.entries()) {
      if (settled[index] !== undefined) continue;
      const material = materials[index] as KeyMaterial | null | undefined;
      if (material === undefined) throw new Error('cached-embedding-service: index out of range');
      const flight = material === null ? undefined : inflight.get(material.key);
      if (flight !== undefined) {
        pending.set(index, flight);
        preexisting.add(index);
      } else {
        computeIndices.push(index);
      }
    }
    if (computeIndices.length > 0) {
      const batchPromise = embeddings.embedBatch(
        computeIndices.map((index) => values[index] as string),
        opts,
      );
      for (const [position, index] of computeIndices.entries()) {
        const material = materials[index] as KeyMaterial | null | undefined;
        if (material === undefined) throw new Error('cached-embedding-service: index out of range');
        const derived: Promise<readonly number[]> = batchPromise.then((vectors) => {
          const vector = vectors[position];
          if (vector === undefined) {
            throw new Error(
              'cached-embedding-service: embedding provider returned fewer vectors than requested',
            );
          }
          return Object.freeze([...vector]);
        });
        if (material !== null && !inflight.has(material.key)) {
          // Guard against unhandled-rejection noise if our caller abandons
          // the batch while a coalesced waiter still holds `derived`.
          derived.catch(() => undefined);
          inflight.set(material.key, derived);
          owned.push({ key: material.key, promise: derived });
        }
        pending.set(index, derived);
      }
    }
    try {
      for (const [index, promise] of pending) {
        const vector = await promise;
        settled[index] = vector;
        const material = materials[index] as KeyMaterial | null | undefined;
        if (material === undefined) throw new Error('cached-embedding-service: index out of range');
        if (material !== null && cached[index] === null && !preexisting.has(index)) {
          await safeSet(material, vector);
        }
      }
    } finally {
      for (const { key, promise } of owned) {
        if (inflight.get(key) === promise) inflight.delete(key);
      }
    }
    return settled.map((vector) => [...(vector as readonly number[])]);
  }

  return {
    embed: embedWithCache,
    embedBatch: embedBatchWithCache,
    stats: (): EmbeddingCacheStats => store.stats(),
    pendingCount: (): number => inflight.size,
    describe: (): CachedEmbeddingServiceContext => frozenContext,
  };
}
