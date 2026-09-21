# Cache Matrix (WP-8 runtime)

Secret-free. Version: `cache-matrix-v1` (code: `CACHE_MATRIX_VERSION` in
`packages/application/src/cache/cache-matrix.ts`).

Five layers with separate keys, tenancy, versions, TTL, invalidation,
eligibility, failure mode, stampede control, telemetry, cost, and rollback.
TTLs below are policy starting values subject to the WP-8 capacity and cost
runs, not release promises.

## 1. Turn-result / idempotency cache

- Purpose: idempotent retry/resume for one user and turn id.
- Key: `tr:<matrixVersion>:u<userIdHash>:t<turnId>:f<turnFingerprint>`.
- Tenancy: user+turn. Correctness-sensitive; never shared across turns or users.
- Versions: matrix version + turn fingerprint (prompt/config shape).
- TTL: 15 minutes; invalidated on turn completion/cancellation.
- Eligibility: same userId and turnId with a matching fingerprint only.
- Failure mode: **fail closed**. Redis degradation rejects the guarded write
  with an explicit reason; idempotency never silently fail-open.
- Stampede control: no duplicate execution without the idempotency lease.
- Telemetry: hit / miss / fingerprint_mismatch / fail_closed.
- Cost: small payloads; cost is Redis ops, not model tokens.
- Rollback: disable reads; keep writes so retries stay idempotent.

## 2. Verified-answer cache

- Purpose: reuse a verified first-turn answer for an exact-normalized query.
- Key: `va:<matrixVersion>:u<userIdHash>:q<normalizedQueryHash>:p<promptVersion+toolCatalogVersion+schemaDigest>`.
- Tenancy: user. No cross-user reuse without an explicit auth/privacy design.
- Versions: prompt version, tool-catalog version, schema digest.
- TTL: 60 minutes; invalidated on TTL, prompt/catalog rotation, explicit user correction.
- Eligibility: grounding decision `verified` only. `rejected` and `unverified`
  are never stored and never served as grounded.
- Failure mode: fail open (degraded miss) with a duplicate-work slot.
- Stampede control: bounded single-flight per key; capped duplicate generations
  (`STAMPEDE_DEFAULT_MAX_DUPLICATE_GENERATIONS = 3`).
- Telemetry: hit / miss / ineligible_decision / fail_open_degraded.
- Cost: saves a full turn on hit; expected hit rate limited by exact normalization.
- Rollback: disable reads first, then writes; force re-verification.

## 3. Embedding cache

- Purpose: reuse query embeddings across turns and subquestions.
- Key: `emb:<matrixVersion>:t<tenantId>:m<modelId>:v<modelVersion>:d<dimensions>:q<queryHash>`.
- Tenancy: tenant. Mismatch fails closed; model/version/dimension mismatch is a
  stale-version miss, never served data.
- Versions: embedding model id/version + dimensions.
- TTL: 24 hours; invalidated on TTL or model/version/dimension change.
- Eligibility: independent `embeddingCacheEnabled` flag + normalized query.
- Failure mode: fail open; storage errors count and return a miss.
- Stampede control: bounded single-flight per key (`maxWaitMs`, `maxFanIn`).
- Telemetry: hit / miss / stale_version / fail_open_degraded.
- Cost: saves embedding provider calls; Redis payload is small dense vectors.
- Rollback: independent flag off; callers recompute embeddings.
- WP-9 activation: `src/composition.ts` wraps the search `EmbeddingService`
  with `createCachedEmbeddingService` when `WP8_EMBEDDING_RETRIEVAL_CACHE_ENABLED=1`
  (default off); tenant is the single-deployment constant, model version comes
  from `EMBEDDING_MODEL_VERSION` (must rotate on silent provider weight changes).
  Redis adapters tolerate Upstash JSON auto-deserialization.

## 4. Retrieval-candidate cache

- Purpose: reuse candidate ids/scores for repeated searches.
- Key: `rc:<matrixVersion>:t<tenantId>:c<corpusVersion>:i<indexVersion>:<modality>:f<filterHash>:v<retrievalConfigVersion>:q<queryHash>`.
- Tenancy: tenant+corpus. Entries store ids and scores only, never document text.
- Versions: corpus, index, retrieval config.
- TTL: 30 minutes; invalidated on TTL or any version/filter change.
- Eligibility: independent `retrievalCacheEnabled` flag. Cached entries retain
  score and query provenance (`queryId`, `subquestionId`, per-signal scores).
- Failure mode: fail open; storage errors count and return a miss.
- Stampede control: bounded single-flight per key. Dedup/backfill stay
  turn-local after cached candidates are loaded.
- Telemetry: hit / miss / stale_version / fail_open_degraded.
- Cost: saves vector/lexical DB work at the price of Redis ops and staleness risk.
- Rollback: independent flag off; retrieval executes uncached.
- WP-9 activation: `searchChunks` consults the port per modality pool when
  `candidateCache`/`candidateCacheVersions` are provided (composition provides
  them when `WP8_EMBEDDING_RETRIEVAL_CACHE_ENABLED=1`, default off).
  Fusion, rerank, resolve, and turn-local exclusion/backfill always re-run on
  loaded pools; rehydration is all-or-nothing (any deleted chunk is a miss).
  Pool entries carry pool-scope synthetic provenance that downstream
  orchestration overwrites from the live plan. Corpus version starts at
  `corpus-v1` (bump on pipeline change); index version derives from the
  embedding model + dimensions.

## 5. Provider prompt cache

- Purpose: discount/reuse an identical input prefix within model calls.
  Does not skip the call and is not guaranteed by configuration.
- Key: owned by infrastructure adapters (OpenAI-compatible key material,
  Google cached-content resources, breakpoints). Application code holds no
  provider option keys.
- Tenancy: provider prefix, adapter-owned.
- Versions: system-prompt version, tool-catalog version, schema digest,
  history-shape version (`prompt-prefix-v1:<digest>`).
- TTL: provider-managed.
- Eligibility: capability-gated (`automatic`/`explicit`); reuse must be
  observed per model step with `reported` telemetry, never assumed.
- Failure mode: fail open (normal billing applies).
- Stampede control: not applicable; the call is never skipped.
- Telemetry: per-step input / cache-read / cache-write / uncached / output
  with status `reported` / `unsupported` / `missing` / `parse_error`, TTFT and
  total latency where available, provider-specific billable cost with
  `complete` / `partial` / `unknown` completeness. Missing fields are never
  zero; savings require observed per-step evidence versus the uncached
  counterfactual.
- Cost: priced with provider-specific cache read/write rates per step.
- Rollback: prefix identity stays versioned; adapters drop explicit key material.

## Redis degradation + stampede policy

The circuit breaker (`packages/application/src/cache/redis-circuit-breaker.ts`)
separates classes:

- `closed`: all layers admitted.
- `open`: `turn_result` coordination rejects fail-closed
  (`idempotency_redis_unavailable`); optional layers degrade fail-open and may
  regenerate only with a duplicate-work slot (`maxDuplicateWork` cap).
- `half_open`: probes admitted until `successThreshold` consecutive successes
  close the breaker; any failure re-opens it.

Redis degradation therefore cannot cause an unlimited generation stampede:
duplicate work is capped, fan-in is bounded, and correctness-critical
idempotency fails closed with an explicit reason.
