import {
  buildRetrievalCandidateCacheKey,
  type CachedCandidate,
  type RetrievalCandidateCacheStats,
  type RetrievalCandidateCacheStore,
  type RetrievalCandidateKeyInput,
  type RetrievalCandidateLookup,
} from './retrieval-candidate-cache';

/**
 * Candidate-cache port adapter (WP-9 workstream B, F-34 wiring preparation).
 *
 * Adapts the WP-8 {@link RetrievalCandidateCacheStore} to the
 * application-owned `CandidateCachePort`
 * (packages/application/src/agent/search/candidate-cache-port.ts).
 *
 * Why this adapter is structural instead of importing the port: the
 * dependency-cruiser rule `no-infrastructure-importing-application` forbids
 * ANY import from `packages/application` here, even type-only (the rule is
 * path-based). The application port therefore mirrors this module's shapes
 * field-for-field, and this adapter returns exactly that member set
 * (`get`/`set`/`stats`) plus {@link buildKey}. Conformance is enforced where
 * both sides are visible: the coordinator's typed assignment in
 * `src/composition.ts`
 * (`const port: CandidateCachePort = createCandidateCachePort(store)`),
 * which fails to compile on any drift. Candidate/score/input shapes are
 * identical on both sides on purpose, so this adapter stays pass-through;
 * if the shapes ever diverge, add explicit mapping here, in exactly one
 * place.
 *
 * Failure behavior is inherited from the store: `get` degrades storage
 * failures to `{ outcome: 'error_degraded' }` and `set` swallows them with a
 * counted `errors` increment (fail-open, per the cache matrix). This adapter
 * adds no throwing paths of its own; only programmer-misuse (an invalid key
 * input) throws out of `buildKey`, fail-fast at wiring time.
 */

export type {
  CachedCandidate,
  RetrievalCandidateCacheStats,
  RetrievalCandidateCacheStore,
  RetrievalCandidateKeyInput,
  RetrievalCandidateLookup,
};

export interface CandidateCachePortAdapter {
  /** Build the versioned storage key string (single-sourced key format). */
  buildKey(input: RetrievalCandidateKeyInput): string;
  get(key: string, expected: RetrievalCandidateKeyInput): Promise<RetrievalCandidateLookup>;
  set(
    key: string,
    input: RetrievalCandidateKeyInput,
    candidates: readonly CachedCandidate[],
  ): Promise<void>;
  stats(): RetrievalCandidateCacheStats;
}

export function createCandidateCachePort(
  store: RetrievalCandidateCacheStore,
): CandidateCachePortAdapter {
  return {
    buildKey: (input: RetrievalCandidateKeyInput): string => buildRetrievalCandidateCacheKey(input),
    get: (key: string, expected: RetrievalCandidateKeyInput): Promise<RetrievalCandidateLookup> =>
      store.get(key, expected),
    set: (
      key: string,
      input: RetrievalCandidateKeyInput,
      candidates: readonly CachedCandidate[],
    ): Promise<void> => store.set(key, input, candidates),
    stats: (): RetrievalCandidateCacheStats => store.stats(),
  };
}
