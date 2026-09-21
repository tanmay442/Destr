import { z } from 'zod';
import type { RetrievedChunkRow } from '@app/domain';
import type { RetrievedChunk } from '../../rag/search/search-types';

/**
 * Candidate-cache port (WP-9 workstream B, F-34 wiring preparation).
 *
 * Application-owned interface mirroring the WP-8
 * `RetrievalCandidateCacheStore` operations (get/set/stats over a string key
 * plus a key input), with NO infrastructure imports. The infrastructure
 * adapter (`candidate-cache-port-adapter.ts`) implements this shape
 * structurally; the dependency-cruiser rule
 * `no-infrastructure-importing-application` forbids the adapter from
 * importing this file even type-only, so conformance is checked where both
 * sides are visible: the typed assignment in `src/composition.ts`.
 *
 * Why not reuse the WP-8 store types directly? The application layer may not
 * import infrastructure (cruiser rule `no-application-importing-infrastructure`).
 * The two shapes are intentionally field-for-field identical so the adapter
 * stays pass-through; if they ever diverge, explicit mapping belongs in the
 * adapter, in exactly one place.
 *
 * Rehydration path: cached entries keep ids and scores only, never text
 * (cache-matrix policy). The WP-8 entry schema drops the numeric chunk PK,
 * keeping `(documentId, chunkIndex[, chunkUid])`, and no PK-by-UID lookup
 * exists on `ChunkRepository` (verified 2026-09-19: only `getByIds`,
 * `getByDocAndRange`, `getByDocAndRanges`). `getByIds` rehydration is
 * therefore impossible without a schema migration, so
 * {@link fetchCandidateRows} rehydrates via `getByDocAndRanges` grouped by
 * document, and {@link rehydrateCandidates} exact-matches all-or-nothing.
 * Follow-up if `getByIds` rehydration is ever wanted: add the numeric chunk
 * id to the entry schema behind a cache-version bump (stale-version
 * rejection keeps the rollout safe).
 */

export const CandidateCacheModalitySchema = z.enum(['vector', 'lexical', 'fused']);
export type CandidateCacheModality = z.infer<typeof CandidateCacheModalitySchema>;

export const CandidateCacheKeyInputSchema = z.object({
  tenantId: z.string().min(1).max(200),
  corpusVersion: z.string().min(1).max(200),
  indexVersion: z.string().min(1).max(200),
  normalizedQuery: z.string().min(1).max(2_000),
  modality: CandidateCacheModalitySchema,
  filterHash: z.string().min(1).max(200),
  retrievalConfigVersion: z.string().min(1).max(200),
});
export type CandidateCacheKeyInput = z.infer<typeof CandidateCacheKeyInputSchema>;

export const CandidateCacheScoresSchema = z.object({
  dense: z.number().finite().optional(),
  lexical: z.number().finite().optional(),
  fusion: z.number().finite().optional(),
  reranker: z.number().finite().optional(),
  finalRank: z.number().int().min(0),
  finalSignal: z.enum(['dense', 'lexical', 'fusion', 'reranker']),
});
export type CandidateCacheScores = z.infer<typeof CandidateCacheScoresSchema>;

export const CandidateCacheEntrySchema = z.object({
  chunkUid: z.string().min(1).max(200).optional(),
  documentId: z.number().int().min(0),
  chunkIndex: z.number().int().min(0),
  queryId: z.string().min(1).max(200),
  subquestionId: z.string().min(1).max(200),
  scores: CandidateCacheScoresSchema,
});
export type CandidateCacheEntry = z.infer<typeof CandidateCacheEntrySchema>;

export type CandidateCacheLookup =
  | { readonly outcome: 'hit'; readonly candidates: readonly CandidateCacheEntry[] }
  | { readonly outcome: 'miss' }
  | { readonly outcome: 'stale_version' }
  | { readonly outcome: 'error_degraded' };

export interface CandidateCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly sets: number;
  readonly staleVersions: number;
  readonly errors: number;
}

/** Application-owned mirror of the WP-8 store operations. */
export interface CandidateCachePort {
  /** Build the versioned storage key string (single-sourced key format). */
  buildKey(input: CandidateCacheKeyInput): string;
  get(key: string, expected: CandidateCacheKeyInput): Promise<CandidateCacheLookup>;
  set(key: string, input: CandidateCacheKeyInput, candidates: readonly CandidateCacheEntry[]): Promise<void>;
  stats(): CandidateCacheStats;
}

/**
 * Narrow chunk source for rehydration. Structurally satisfied by
 * `ChunkRepository`; kept narrow so tests can pass fakes.
 */
export interface CandidateChunkSource {
  getByDocAndRanges(
    ranges: Array<{ documentId: number; start: number; end: number }>,
    opts?: { signal?: AbortSignal },
  ): Promise<Map<string, RetrievedChunkRow[]>>;
}

/**
 * Query normalization. Intentional duplicate of the answer-cache/embedding
 * normalization algorithm (trim, lowercase, collapse whitespace, tighten
 * punctuation); the layering rules forbid importing it from infrastructure,
 * so keep the three copies in sync.
 */
export function normalizeCandidateQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s+([?.!,;:])/g, '$1')
    .trim();
}

function filterHashFor(filter: { documentId?: number } | undefined): string {
  if (filter?.documentId !== undefined) {
    if (!Number.isInteger(filter.documentId) || filter.documentId < 0) {
      throw new Error('candidate-cache-port: filter.documentId must be a non-negative integer');
    }
    return `doc:${filter.documentId}`;
  }
  return 'nofilter';
}

export interface CandidateCacheContextInput {
  readonly tenantId: string;
  readonly corpusVersion: string;
  readonly indexVersion: string;
  readonly query: string;
  readonly modality: CandidateCacheModality;
  readonly filter?: { documentId?: number } | undefined;
  readonly retrievalConfigVersion: string;
}

/**
 * Build a validated cache key input from call-site ("cfg-ish") values.
 * The query is normalized here; versions are explicit inputs because no
 * production corpus/index/config versioning exists yet (see the wiring
 * snippet for the constants the coordinator must define and rotate).
 * Throws on invalid input (fail-fast wiring errors); storage failures
 * degrade later at the port boundary, never here.
 */
export function buildCandidateCacheContext(input: CandidateCacheContextInput): CandidateCacheKeyInput {
  const normalizedQuery = normalizeCandidateQuery(input.query);
  return CandidateCacheKeyInputSchema.parse({
    tenantId: input.tenantId,
    corpusVersion: input.corpusVersion,
    indexVersion: input.indexVersion,
    normalizedQuery,
    modality: input.modality,
    filterHash: filterHashFor(input.filter),
    retrievalConfigVersion: input.retrievalConfigVersion,
  });
}

export interface CandidateProvenance {
  readonly queryId: string;
  readonly subquestionId: string;
}

/** Hard cap matching the WP-8 entry schema (`z.array(...).max(500)`). */
export const MAX_CACHED_CANDIDATES = 500 as const;

/**
 * Strip a search result down to ids + scores + provenance. Never carries
 * text: the output type has no content field by construction. Truncates to
 * the leading {@link MAX_CACHED_CANDIDATES} entries (results are
 * relevance-ordered; the store would reject an oversized set wholesale).
 */
export function candidatesFromSearchResult(
  chunks: readonly RetrievedChunk[],
  provenance: CandidateProvenance,
): CandidateCacheEntry[] {
  if (provenance.queryId.trim() === '' || provenance.subquestionId.trim() === '') {
    throw new Error('candidate-cache-port: queryId and subquestionId must not be empty');
  }
  return chunks.slice(0, MAX_CACHED_CANDIDATES).map((chunk) =>
    CandidateCacheEntrySchema.parse({
      ...(chunk.chunkUid !== undefined ? { chunkUid: chunk.chunkUid } : {}),
      documentId: chunk.documentId,
      chunkIndex: chunk.chunkIndex,
      queryId: provenance.queryId,
      subquestionId: provenance.subquestionId,
      scores: {
        ...(chunk.scores.dense !== undefined ? { dense: chunk.scores.dense } : {}),
        ...(chunk.scores.lexical !== undefined ? { lexical: chunk.scores.lexical } : {}),
        ...(chunk.scores.fusion !== undefined ? { fusion: chunk.scores.fusion } : {}),
        ...(chunk.scores.reranker !== undefined ? { reranker: chunk.scores.reranker } : {}),
        finalRank: chunk.scores.finalRank,
        finalSignal: chunk.scores.finalSignal,
      },
    }),
  );
}

function rowKey(documentId: number, chunkIndex: number): string {
  return `${documentId}:${chunkIndex}`;
}

/**
 * Rebuild full search chunks from cached ids/scores plus freshly fetched
 * rows. Pure and all-or-nothing: any candidate without an exact row match
 * (by documentId+chunkIndex, preferring chunkUid on ties) returns `null`
 * (a miss — the caller runs uncached retrieval). Entries whose scores lack
 * the `finalSignal` value are also a miss, never served. Ranks are preserved
 * from the cached scores; turn-local dedup/backfill stays the caller's job.
 */
export function rehydrateCandidates(
  candidates: readonly CandidateCacheEntry[],
  rows: readonly RetrievedChunkRow[],
): RetrievedChunk[] | null {
  const byIdentity = new Map<string, RetrievedChunkRow[]>();
  for (const row of rows) {
    const key = rowKey(row.documentId, row.chunkIndex);
    const bucket = byIdentity.get(key);
    if (bucket === undefined) byIdentity.set(key, [row]);
    else bucket.push(row);
  }
  const rehydrated: RetrievedChunk[] = [];
  for (const candidate of candidates) {
    const bucket = byIdentity.get(rowKey(candidate.documentId, candidate.chunkIndex));
    if (bucket === undefined || bucket.length === 0) return null;
    let row: RetrievedChunkRow | undefined;
    if (candidate.chunkUid !== undefined) {
      row = bucket.find((candidate2) => candidate2.chunkUid === candidate.chunkUid) ?? bucket[0];
    } else {
      row = bucket[0];
    }
    if (row === undefined) return null;
    if (candidate.scores[candidate.scores.finalSignal] === undefined) return null;
    rehydrated.push({
      id: row.id,
      documentId: row.documentId,
      ...(row.documentUid !== undefined ? { documentUid: row.documentUid } : {}),
      ...(row.chunkUid !== undefined ? { chunkUid: row.chunkUid } : {}),
      fileName: row.fileName,
      page: row.page,
      sectionTitle: row.sectionTitle,
      source: row.source,
      title: row.title,
      content: row.content,
      chunkIndex: row.chunkIndex,
      scores: {
        ...(candidate.scores.dense !== undefined ? { dense: candidate.scores.dense } : {}),
        ...(candidate.scores.lexical !== undefined ? { lexical: candidate.scores.lexical } : {}),
        ...(candidate.scores.fusion !== undefined ? { fusion: candidate.scores.fusion } : {}),
        ...(candidate.scores.reranker !== undefined ? { reranker: candidate.scores.reranker } : {}),
        finalRank: candidate.scores.finalRank,
        finalSignal: candidate.scores.finalSignal,
      },
    });
  }
  return rehydrated;
}

/**
 * Fetch the rows needed for {@link rehydrateCandidates}: one
 * `[minChunkIndex, maxChunkIndex]` range per document, then flatten every
 * map value (robust to the store's `documentId:start:end` key format).
 * Extra rows in the ranges are harmless — rehydration exact-matches.
 */
export async function fetchCandidateRows(
  candidates: readonly CandidateCacheEntry[],
  source: CandidateChunkSource,
  opts: { signal?: AbortSignal } = {},
): Promise<RetrievedChunkRow[]> {
  if (candidates.length === 0) return [];
  const bounds = new Map<number, { start: number; end: number }>();
  for (const candidate of candidates) {
    const bound = bounds.get(candidate.documentId);
    if (bound === undefined) {
      bounds.set(candidate.documentId, { start: candidate.chunkIndex, end: candidate.chunkIndex });
    } else {
      bound.start = Math.min(bound.start, candidate.chunkIndex);
      bound.end = Math.max(bound.end, candidate.chunkIndex);
    }
  }
  const ranges = [...bounds].map(([documentId, bound]) => ({
    documentId,
    start: bound.start,
    end: bound.end,
  }));
  const byRange = await source.getByDocAndRanges(ranges, opts);
  const rows: RetrievedChunkRow[] = [];
  for (const bucket of byRange.values()) rows.push(...bucket);
  return rows;
}
