# Database Hardening (WP-8, F-36/F-38)

Scope: infrastructure-only changes. No migration was required; the
no-migration decision is recorded in §6.

## 1. Pool lifecycle

One stable pool per effective runtime config (`packages/infrastructure/src/db/pool.ts`):
pool construction is keyed by URL + poolMax + driver + pooled-Neon flag + SSL
mode, so a later caller can never inherit a pool built for different capacity.
Production Neon default is 5 connections; the hard configuration maximum is 20.

New guards (`packages/infrastructure/src/db/pool-metrics.ts`):

- `poolVariantKey` mirrors the pool cache key (URL redacted to host) so the
  number of live variants is countable.
- `assertBoundedPoolVariants` caps distinct live pool configurations (default 4).
- `assertSanePoolMax` rejects poolMax < 2 (a single connection serializes all
  queries and starves cancellation paths) and poolMax > 20. A larger pool does
  not create database capacity — size from measured query demand (§5 of the
  capacity model), never upward from load failures.
- `tryAttachPoolLifecycle` registers `pool.end()` with a runtime-provided
  shutdown hook when one exists and reports `{ supported: false }` without
  throwing when it does not. No implicit global Vercel hook is assumed; request
  paths cannot crash on runtimes without the helper.
- `assertPooledNeonEndpoint` requires Neon's pooled endpoint in production and
  reports not-applicable elsewhere (local/non-Neon). Existing configuration
  parsing already warns on non-pooled production Neon URLs.

## 2. Query-class timeouts

`packages/infrastructure/src/db/query-timeouts.ts`. The shared 30 s server
backstop (`DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS`) stays; every interactive
class is strictly shorter:

| Query class | Ceiling | Rationale |
|---|---:|---|
| `history` | 2,000 ms | bounded tail lookups, index-backed |
| `telemetry` | 2,000 ms | never blocks answer release |
| `retrieval_vector` | 4,000 ms | HNSW/candidate scan + rerank budget |
| `retrieval_lexical` | 4,000 ms | GIN bitmap + ranking budget |
| `persistence` | 5,000 ms | multi-row writes, moderate |
| `background` | 10,000 ms | longest, still below the backstop |

Rules: overrides above 30 s clamp to the backstop with a warning;
`statementTimeoutStatement` renders only validated integers (no SQL injection
surface); `assertFitsParentBudget` rejects child timeouts that exceed the
remaining turn budget. Initial values are measurement starting points — tune
from p99 service time, never upward from load failures.

Cancellation: Neon-serverless queries cannot be cancelled from the client and
depend on the server timeout after caller cancellation; node-postgres paths use
`pg_cancel_backend` via `executeDatabaseCancelable` (unchanged). `DetachedQueryTracker`
measures orphaned work after caller cancellation until it ends (`completed` /
`cancelled_by_db`) or its timeout elapses (`timeout_reached`), so cancellation
storms are observable instead of silent.

WP-9 activation: `executeDatabaseCancelable` accepts an optional `queryClass`
and, for clients that support transactions, issues the class `SET LOCAL
statement_timeout` inside the transaction before running the operation.
Applied at the retrieval call sites (`searchChunksByVector`,
`searchChunksByLexical`, chunk-store point reads). Follow-ups with an owner
and condition (not started): history/telemetry/persistence repositories
(builder-based, need transaction wrapping plus write-timeout failure
semantics), and `DetachedQueryTracker` hookup (needs query-id generation and
a shared instance lifecycle).

## 3. Pool and wait metrics

`collectPoolStats` reads total/idle/busy/waiting/maxSize from pg-style pools and
reports `null` (unknown) for drivers that do not expose a counter — it never
throws on the request path. `PoolWaitTracker` records checkout waits with
p50/p95/max/timeout counts and raises `waiterGrowthAlert` after five
consecutive measurement windows of strictly increasing waiter counts (the §12.6
early-warning signal for pool saturation). Feed it per-window waiting counts via
`observeWaiting` and checkout latencies via `recordWait`.

## 4. EXPLAIN (ANALYZE, BUFFERS) evidence — non-production dataset

Method (local cluster only, never production): created isolated database
`ragagent_explain` mirroring the production `chunks`/`documents` shape, indexes
(HNSW partial `embedding_idx`, GIN `chunks_tsv_idx`/`chunks_search_tsv_idx`,
btree document/chunk lookups), and generated tsvector columns; seeded a
deterministic synthetic corpus (8 documents × 400 chunks, 768-dim); ran
read-only `EXPLAIN (ANALYZE, BUFFERS)` with the production query shapes;
dropped the database afterwards. Dev database untouched (0 chunks before/after).

| # | Query shape | Plan (PG 16.15, pgvector, 3,200 rows) | Time |
|---|---|---|---|
| Q1 | Vector candidate CTE, unfiltered | Seq Scan + top-N heapsort; **HNSW not chosen**; 20,545 buffer hits | 35.6 ms |
| Q2 | Vector candidate CTE, `document_id = 3` | Bitmap index on `chunks_document_id_idx` (400 rows), then exact distance sort; filter applied inside candidate selection | 5.6 ms |
| Q3 | Lexical `plainto_tsquery` + `ts_rank` | Bitmap index on `chunks_tsv_idx` (532 rows), top-N sort | 3.8 ms |
| Q4 | Weighted `websearch_to_tsquery` + `ts_rank_cd` | Bitmap index on `chunks_search_tsv_idx` (534 rows), top-N sort | 5.0 ms |
| Q5 | History/bounded tail (`document_id`, index backward, LIMIT 20) | Backward index scan on `(document_id, chunk_index)` | 0.13 ms |
| Q6 | `SET LOCAL statement_timeout` | Transaction-scoped as the app uses it (bare `SET LOCAL` outside a transaction warns and is a no-op — procedure note, not a defect) | — |

Reading:

- Q2 confirms the F-16 fix shape: document filters apply inside candidate
  selection (bitmap pre-filter to 400 rows) and again defensively, so scoped
  searches cannot lose candidates to global rows.
- Q3/Q4 confirm GIN engagement for both lexical modes; Q5 confirms bounded
  history lookups are index-only and sub-millisecond.
- Q1/Q-direct (direct `ORDER BY embedding <=> … LIMIT 50` also exact-scans at
  24 ms): at 3,200 rows the planner correctly prefers exact scan over HNSW —
  the partial index is present and predicate-matched, but HNSW traversal only
  wins at larger scale. **HNSW engagement and filtered-vector/lexical behavior
  under concurrency at production-like corpus size remain UNVERIFIED** and must
  be re-measured on a production-scale non-prod snapshot before any 4k/20k
  claim. The subquery-parameterized vector literal is a further watch item for
  index selection at scale (follow-up for retrieval-owning work; queries
  unchanged here).
- All timings are single-query local-SSD numbers, not concurrency or
  production evidence. Under-concurrency plans are covered synthetically by the
  capacity gate's pool-wait assertions, not by this table.

## 5. No-migration decision

No schema, index, or extension change was required:

- Pool lifecycle, variant bounds, and pooled-endpoint assertions are
  configuration/runtime behavior — no DDL.
- Query-class timeouts are per-query `SET LOCAL statement_timeout` settings —
  no DDL.
- Metrics and detached-query tracking are in-process telemetry — no tables.
- The EXPLAIN review found no missing index: HNSW, both GIN vector indexes,
  and the document/chunk btree coverage already exist in `drizzle/` (verified:
  `embedding_idx`, `chunks_tsv_idx`, `chunks_search_tsv_idx`,
  `chunks_document_id_idx`, `chunks_document_id_chunk_index_idx`).

`pnpm db:check` journal state is unchanged. If a future corpus-scale review
required an index or setting change, the analysis would be prepared and the
change stopped at review — migrations are never applied from this workstream
without separate approval, rehearsal, and rollback evidence.

## 6. Residual risks

- Real-corpus HNSW engagement, PgBouncer queueing, Neon compute/IOPS headroom,
  and statement-timeout rates are UNVERIFIED until the authorized runs.
- Neon-path queries remain un-cancellable client-side; short class timeouts
  bound the blast radius but cancellation storms still need the authorized
  fault-injection run to confirm pool behavior.
- Pool-wait and waiter-growth signals need dashboard wiring (thresholds in
  `docs/runtime/capacity-model.md` §5) before rollout.
